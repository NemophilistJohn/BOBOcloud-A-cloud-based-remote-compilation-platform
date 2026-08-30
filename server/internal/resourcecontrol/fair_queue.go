package resourcecontrol

import (
	"context"
	"sort"
	"time"

	"bobocloud-server/internal/resourcegovernor"
)

type queuedState uint8

const (
	queuedWaiting queuedState = iota
	queuedGranted
	queuedFinished
)

type queuedResult struct {
	lease *Lease
	err   error
}

type queuedAdmission struct {
	admission  Admission
	resources  resourcegovernor.Resources
	ctx        context.Context
	started    time.Time
	enqueuedAt time.Time
	result     chan queuedResult
	state      queuedState
}

type projectQueue struct {
	id    string
	items []*queuedAdmission
}

type ownerQueue struct {
	id            string
	projects      []*projectQueue
	projectCursor int
	depth         int
}

type workloadQueue struct {
	owners      []*ownerQueue
	ownerCursor int
	depth       int
}

type queueCandidate struct {
	item         *queuedAdmission
	ownerIndex   int
	projectIndex int
}

type fairQueue struct {
	policy       QueuePolicy
	classes      [workloadCount]workloadQueue
	total        int
	ownerDepth   map[string]int
	projectDepth map[string]int
	schedule     []Workload
	cursor       int
}

func newFairQueue(policy QueuePolicy) *fairQueue {
	return &fairQueue{
		policy: policy, ownerDepth: make(map[string]int), projectDepth: make(map[string]int),
		schedule: buildWeightedSchedule(policy),
	}
}

func buildWeightedSchedule(policy QueuePolicy) []Workload {
	total := 0
	for workload := Workload(0); workload < workloadCount; workload++ {
		if policy.Workloads[workload].MaxWaiting > 0 {
			total += policy.Workloads[workload].Weight
		}
	}
	if total <= 0 {
		return nil
	}
	current := [workloadCount]int{}
	result := make([]Workload, 0, total)
	for len(result) < total {
		selected := Workload(workloadCount)
		for workload := Workload(0); workload < workloadCount; workload++ {
			entry := policy.Workloads[workload]
			if entry.MaxWaiting <= 0 {
				continue
			}
			current[workload] += entry.Weight
			if selected >= workloadCount || current[workload] > current[selected] {
				selected = workload
			}
		}
		if selected >= workloadCount {
			break
		}
		current[selected] -= total
		result = append(result, selected)
	}
	return result
}

func (queue *fairQueue) canEnqueue(admission Admission) AdmissionErrorCode {
	if queue.total >= queue.policy.MaxWaiting {
		return AdmissionQueueFull
	}
	classPolicy := queue.policy.Workloads[admission.Workload]
	if queue.classes[admission.Workload].depth >= classPolicy.MaxWaiting {
		return AdmissionQueueFull
	}
	if queue.ownerDepth[admission.OwnerID] >= queue.policy.MaxWaitingPerOwner {
		return AdmissionOwnerQueueFull
	}
	if queue.projectDepth[projectDepthKey(admission)] >= queue.policy.MaxWaitingPerProject {
		return AdmissionProjectQueueFull
	}
	return ""
}

func (queue *fairQueue) enqueue(item *queuedAdmission) {
	class := &queue.classes[item.admission.Workload]
	owner := findOwner(class, item.admission.OwnerID)
	if owner == nil {
		owner = &ownerQueue{id: item.admission.OwnerID}
		class.owners = append(class.owners, owner)
	}
	project := findProject(owner, item.admission.ScopeID)
	if project == nil {
		project = &projectQueue{id: item.admission.ScopeID}
		owner.projects = append(owner.projects, project)
	}
	project.items = append(project.items, item)
	owner.depth++
	class.depth++
	queue.total++
	queue.ownerDepth[item.admission.OwnerID]++
	queue.projectDepth[projectDepthKey(item.admission)]++
}

func findOwner(class *workloadQueue, ownerID string) *ownerQueue {
	for _, owner := range class.owners {
		if owner.id == ownerID {
			return owner
		}
	}
	return nil
}

func findProject(owner *ownerQueue, projectID string) *projectQueue {
	for _, project := range owner.projects {
		if project.id == projectID {
			return project
		}
	}
	return nil
}

func projectDepthKey(admission Admission) string {
	return admission.OwnerID + "\x00" + admission.ScopeID
}

func (queue *fairQueue) remove(target *queuedAdmission) bool {
	class := &queue.classes[target.admission.Workload]
	for ownerIndex, owner := range class.owners {
		if owner.id != target.admission.OwnerID {
			continue
		}
		for projectIndex, project := range owner.projects {
			if project.id != target.admission.ScopeID {
				continue
			}
			for itemIndex, item := range project.items {
				if item != target {
					continue
				}
				project.items = append(project.items[:itemIndex], project.items[itemIndex+1:]...)
				queue.afterRemoval(class, owner, ownerIndex, projectIndex, target.admission)
				return true
			}
		}
	}
	return false
}

func (queue *fairQueue) pop(candidate queueCandidate) *queuedAdmission {
	class := &queue.classes[candidate.item.admission.Workload]
	if candidate.ownerIndex >= len(class.owners) {
		return nil
	}
	owner := class.owners[candidate.ownerIndex]
	if candidate.projectIndex >= len(owner.projects) {
		return nil
	}
	project := owner.projects[candidate.projectIndex]
	if len(project.items) == 0 || project.items[0] != candidate.item {
		return nil
	}
	project.items = project.items[1:]
	queue.afterRemoval(class, owner, candidate.ownerIndex, candidate.projectIndex, candidate.item.admission)
	return candidate.item
}

func (queue *fairQueue) afterRemoval(class *workloadQueue, owner *ownerQueue, ownerIndex, projectIndex int, admission Admission) {
	owner.depth--
	class.depth--
	queue.total--
	decrementDepth(queue.ownerDepth, admission.OwnerID)
	decrementDepth(queue.projectDepth, projectDepthKey(admission))

	projectRemoved := projectIndex < len(owner.projects) && len(owner.projects[projectIndex].items) == 0
	if projectRemoved {
		owner.projects = append(owner.projects[:projectIndex], owner.projects[projectIndex+1:]...)
	}
	if len(owner.projects) > 0 {
		if projectRemoved {
			owner.projectCursor = projectIndex % len(owner.projects)
		} else {
			owner.projectCursor = (projectIndex + 1) % len(owner.projects)
		}
	} else {
		owner.projectCursor = 0
	}
	ownerRemoved := owner.depth == 0
	if ownerRemoved {
		class.owners = append(class.owners[:ownerIndex], class.owners[ownerIndex+1:]...)
	}
	if len(class.owners) > 0 {
		if ownerRemoved {
			class.ownerCursor = ownerIndex % len(class.owners)
		} else {
			class.ownerCursor = (ownerIndex + 1) % len(class.owners)
		}
	} else {
		class.ownerCursor = 0
	}
}

func decrementDepth(values map[string]int, key string) {
	if values[key] <= 1 {
		delete(values, key)
		return
	}
	values[key]--
}

func (queue *fairQueue) candidates(workload Workload) []queueCandidate {
	class := &queue.classes[workload]
	if len(class.owners) == 0 {
		return nil
	}
	result := make([]queueCandidate, 0, class.depth)
	for ownerOffset := 0; ownerOffset < len(class.owners); ownerOffset++ {
		ownerIndex := (class.ownerCursor + ownerOffset) % len(class.owners)
		owner := class.owners[ownerIndex]
		for projectOffset := 0; projectOffset < len(owner.projects); projectOffset++ {
			projectIndex := (owner.projectCursor + projectOffset) % len(owner.projects)
			project := owner.projects[projectIndex]
			if len(project.items) > 0 {
				result = append(result, queueCandidate{item: project.items[0], ownerIndex: ownerIndex, projectIndex: projectIndex})
			}
		}
	}
	return result
}

func (queue *fairQueue) agedCandidates(now time.Time) []queueCandidate {
	if queue.policy.AgingThreshold <= 0 {
		return nil
	}
	result := make([]queueCandidate, 0, queue.total)
	for workload := Workload(0); workload < workloadCount; workload++ {
		for _, candidate := range queue.candidates(workload) {
			if now.Sub(candidate.item.enqueuedAt) >= queue.policy.AgingThreshold {
				result = append(result, candidate)
			}
		}
	}
	sort.SliceStable(result, func(left, right int) bool {
		return result[left].item.enqueuedAt.Before(result[right].item.enqueuedAt)
	})
	return result
}

func (queue *fairQueue) weightedWorkloads() []Workload {
	if len(queue.schedule) == 0 {
		return nil
	}
	result := make([]Workload, 0, workloadCount)
	seen := [workloadCount]bool{}
	for offset := 0; offset < len(queue.schedule); offset++ {
		index := (queue.cursor + offset) % len(queue.schedule)
		workload := queue.schedule[index]
		if seen[workload] || queue.classes[workload].depth == 0 {
			continue
		}
		seen[workload] = true
		result = append(result, workload)
	}
	return result
}

func (queue *fairQueue) advanceAfter(workload Workload) {
	for offset := 0; offset < len(queue.schedule); offset++ {
		index := (queue.cursor + offset) % len(queue.schedule)
		if queue.schedule[index] == workload {
			queue.cursor = (index + 1) % len(queue.schedule)
			return
		}
	}
}

func (queue *fairQueue) depths() [workloadCount]int64 {
	var result [workloadCount]int64
	for workload := Workload(0); workload < workloadCount; workload++ {
		result[workload] = int64(queue.classes[workload].depth)
	}
	return result
}
