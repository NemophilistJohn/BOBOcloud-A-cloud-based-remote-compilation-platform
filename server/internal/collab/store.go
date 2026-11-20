package collab

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	bolt "go.etcd.io/bbolt"
)

type Store interface {
	SaveTeam(*Team) error
	GetTeam(string) (*Team, error)
	ListTeams() ([]*Team, error)
	DeleteTeam(string) error
	SaveMember(*Member) error
	GetMember(teamID, userID string) (*Member, error)
	ListMembers(teamID string) ([]*Member, error)
	DeleteMember(teamID, userID string) error
	SaveProject(*Project) error
	GetProject(projectID string) (*Project, error)
	ListProjects(teamID string) ([]*Project, error)
	DeleteProject(projectID string) error
	SaveLock(*FileLock) error
	ListLocks(teamID, projectID string) ([]*FileLock, error)
	DeleteLock(teamID, projectID, branch, path string) error
}

func clone[T any](value *T) *T {
	if value == nil {
		return nil
	}
	data, _ := json.Marshal(value)
	var out T
	_ = json.Unmarshal(data, &out)
	return &out
}

func memberKey(teamID, userID string) string { return teamID + "\x00" + userID }
func lockKey(teamID, projectID, branch, path string) string {
	return strings.Join([]string{teamID, projectID, branch, path}, "\x00")
}

type MemoryStore struct {
	mu       sync.Mutex
	teams    map[string]*Team
	members  map[string]*Member
	projects map[string]*Project
	locks    map[string]*FileLock
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{teams: map[string]*Team{}, members: map[string]*Member{}, projects: map[string]*Project{}, locks: map[string]*FileLock{}}
}

func (s *MemoryStore) SaveTeam(v *Team) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.teams[v.ID] = clone(v)
	return nil
}
func (s *MemoryStore) GetTeam(id string) (*Team, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.teams[id]
	if v == nil {
		return nil, fmt.Errorf("team not found")
	}
	return clone(v), nil
}
func (s *MemoryStore) ListTeams() ([]*Team, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Team, 0, len(s.teams))
	for _, v := range s.teams {
		out = append(out, clone(v))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}
func (s *MemoryStore) DeleteTeam(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.teams, id)
	for k, v := range s.members {
		if v.TeamID == id {
			delete(s.members, k)
		}
	}
	for k, v := range s.projects {
		if v.TeamID == id {
			delete(s.projects, k)
		}
	}
	for k, v := range s.locks {
		if v.TeamID == id {
			delete(s.locks, k)
		}
	}
	return nil
}
func (s *MemoryStore) SaveMember(v *Member) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.members[memberKey(v.TeamID, v.UserID)] = clone(v)
	return nil
}
func (s *MemoryStore) GetMember(t, u string) (*Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.members[memberKey(t, u)]
	if v == nil {
		return nil, fmt.Errorf("member not found")
	}
	return clone(v), nil
}
func (s *MemoryStore) ListMembers(t string) ([]*Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Member, 0)
	for _, v := range s.members {
		if v.TeamID == t {
			out = append(out, clone(v))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].JoinedAt.Before(out[j].JoinedAt) })
	return out, nil
}
func (s *MemoryStore) DeleteMember(t, u string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.members, memberKey(t, u))
	return nil
}
func (s *MemoryStore) SaveProject(v *Project) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.projects[v.ID] = clone(v)
	return nil
}
func (s *MemoryStore) GetProject(id string) (*Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.projects[id]
	if v == nil {
		return nil, fmt.Errorf("project not found")
	}
	return clone(v), nil
}
func (s *MemoryStore) ListProjects(t string) ([]*Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Project, 0)
	for _, v := range s.projects {
		if v.TeamID == t {
			out = append(out, clone(v))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}
func (s *MemoryStore) DeleteProject(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.projects, id)
	return nil
}
func (s *MemoryStore) SaveLock(v *FileLock) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.locks[lockKey(v.TeamID, v.ProjectID, v.Branch, v.Path)] = clone(v)
	return nil
}
func (s *MemoryStore) ListLocks(t, p string) ([]*FileLock, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*FileLock, 0)
	for _, v := range s.locks {
		if v.TeamID == t && v.ProjectID == p {
			out = append(out, clone(v))
		}
	}
	return out, nil
}
func (s *MemoryStore) DeleteLock(t, p, b, path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.locks, lockKey(t, p, b, path))
	return nil
}

var (
	teamsBucket    = []byte("collab_teams")
	membersBucket  = []byte("collab_members")
	projectsBucket = []byte("collab_projects")
	locksBucket    = []byte("collab_locks")
)

type BoltStore struct{ db *bolt.DB }

func NewBoltStore(db *bolt.DB) *BoltStore {
	_ = db.Update(func(tx *bolt.Tx) error {
		for _, name := range [][]byte{teamsBucket, membersBucket, projectsBucket, locksBucket} {
			if _, err := tx.CreateBucketIfNotExists(name); err != nil {
				return err
			}
		}
		if tx.Bucket([]byte("collab_invites")) != nil {
			if err := tx.DeleteBucket([]byte("collab_invites")); err != nil {
				return err
			}
		}
		return nil
	})
	return &BoltStore{db: db}
}

func putJSON(db *bolt.DB, bucket []byte, key string, value any) error {
	return db.Update(func(tx *bolt.Tx) error {
		data, err := json.Marshal(value)
		if err != nil {
			return err
		}
		return tx.Bucket(bucket).Put([]byte(key), data)
	})
}
func getJSON[T any](db *bolt.DB, bucket []byte, key string) (*T, error) {
	var out T
	found := false
	err := db.View(func(tx *bolt.Tx) error {
		data := tx.Bucket(bucket).Get([]byte(key))
		if data == nil {
			return nil
		}
		found = true
		return json.Unmarshal(data, &out)
	})
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("not found")
	}
	return &out, nil
}
func listJSON[T any](db *bolt.DB, bucket []byte, match func(*T) bool) ([]*T, error) {
	out := make([]*T, 0)
	err := db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucket).ForEach(func(_, v []byte) error {
			var item T
			if err := json.Unmarshal(v, &item); err != nil {
				return err
			}
			if match == nil || match(&item) {
				out = append(out, &item)
			}
			return nil
		})
	})
	return out, err
}
func del(db *bolt.DB, bucket []byte, key string) error {
	return db.Update(func(tx *bolt.Tx) error { return tx.Bucket(bucket).Delete([]byte(key)) })
}

func (s *BoltStore) SaveTeam(v *Team) error           { return putJSON(s.db, teamsBucket, v.ID, v) }
func (s *BoltStore) GetTeam(id string) (*Team, error) { return getJSON[Team](s.db, teamsBucket, id) }
func (s *BoltStore) ListTeams() ([]*Team, error)      { return listJSON[Team](s.db, teamsBucket, nil) }
func (s *BoltStore) DeleteTeam(id string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		if err := tx.Bucket(teamsBucket).Delete([]byte(id)); err != nil {
			return err
		}
		for _, bname := range [][]byte{membersBucket, projectsBucket, locksBucket} {
			b := tx.Bucket(bname)
			var keys [][]byte
			_ = b.ForEach(func(k, v []byte) error {
				if strings.HasPrefix(string(k), id+"\x00") || strings.Contains(string(v), `"team_id":"`+id+`"`) {
					keys = append(keys, append([]byte(nil), k...))
				}
				return nil
			})
			for _, k := range keys {
				_ = b.Delete(k)
			}
		}
		return nil
	})
}
func (s *BoltStore) SaveMember(v *Member) error {
	return putJSON(s.db, membersBucket, memberKey(v.TeamID, v.UserID), v)
}
func (s *BoltStore) GetMember(t, u string) (*Member, error) {
	return getJSON[Member](s.db, membersBucket, memberKey(t, u))
}
func (s *BoltStore) ListMembers(t string) ([]*Member, error) {
	return listJSON[Member](s.db, membersBucket, func(v *Member) bool { return v.TeamID == t })
}
func (s *BoltStore) DeleteMember(t, u string) error { return del(s.db, membersBucket, memberKey(t, u)) }
func (s *BoltStore) SaveProject(v *Project) error   { return putJSON(s.db, projectsBucket, v.ID, v) }
func (s *BoltStore) GetProject(id string) (*Project, error) {
	return getJSON[Project](s.db, projectsBucket, id)
}
func (s *BoltStore) ListProjects(t string) ([]*Project, error) {
	return listJSON[Project](s.db, projectsBucket, func(v *Project) bool { return v.TeamID == t })
}
func (s *BoltStore) DeleteProject(id string) error { return del(s.db, projectsBucket, id) }
func (s *BoltStore) SaveLock(v *FileLock) error {
	return putJSON(s.db, locksBucket, lockKey(v.TeamID, v.ProjectID, v.Branch, v.Path), v)
}
func (s *BoltStore) ListLocks(t, p string) ([]*FileLock, error) {
	return listJSON[FileLock](s.db, locksBucket, func(v *FileLock) bool { return v.TeamID == t && v.ProjectID == p })
}
func (s *BoltStore) DeleteLock(t, p, b, path string) error {
	return del(s.db, locksBucket, lockKey(t, p, b, path))
}
