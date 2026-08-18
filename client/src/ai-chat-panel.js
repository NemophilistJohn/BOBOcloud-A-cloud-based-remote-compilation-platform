// src/ai-chat-panel.js — AI Chat panel on the right side
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  function t(key, params) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(key, params);
    return String(key).replace(/\{([a-zA-Z0-9_]+)\}/g, function(match, name) {
      return params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  function bindText(element, key, params, options) {
    if (BOBO.i18n && BOBO.i18n.bindText) return BOBO.i18n.bindText(element, key, params, options);
    options = options || {};
    element.textContent = String(options.prefix || '') + t(key, params) + String(options.suffix || '');
    return element;
  }

  function bindAttribute(element, attribute, key, params) {
    if (BOBO.i18n && BOBO.i18n.bindAttribute) return BOBO.i18n.bindAttribute(element, attribute, key, params);
    element.setAttribute(attribute, t(key, params));
    return element;
  }

  var panelEl = null;
  var messagesEl = null;
  var inputEl = null;
  var streamingMsgEl = null;   // the message bubble currently being streamed into
  var streamingContent = '';    // accumulated content during stream
  var contextBarEl = null;
  var filePickerEl = null;   // file picker dropdown
  var cmdSuggestEl = null;   // command suggestions dropdown
  var chatGeneration = 0;
  var historyPreviousFocus = null;
  var inputFocusTimer = null;
  var streamRenderScheduler = BOBO.createStreamRenderScheduler
    ? BOBO.createStreamRenderScheduler(renderPendingStream, { interval: 100 })
    : { schedule: renderPendingStream, flush: renderPendingStream, cancel: function() {} };

  function renderPendingStream() {
    if (!streamingMsgEl || !streamingContent) return;
    renderStreamingContent(streamingMsgEl, streamingContent);
    scrollToBottom();
  }

  function errorText(error) {
    if (!error) return t('ai.error.requestFailed');
    if (error.code) return t(error.code);
    return t('ai.error.requestFailed');
  }

  // ──── Ensure DOM ────
  function ensurePanelDOM() {
    if (panelEl) return;

    panelEl = document.getElementById('ai-chat-panel');
    messagesEl = document.getElementById('ai-chat-messages');
    inputEl = document.getElementById('ai-chat-input');
    contextBarEl = document.getElementById('ai-chat-context');

    if (!panelEl) return;

    // Send button
    var sendBtn = document.getElementById('ai-chat-send');
    if (sendBtn) {
      sendBtn.addEventListener('click', sendMessage);
    }

    // Close button
    var closeBtn = document.getElementById('ai-chat-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        if (BOBO.aiAgentButton) {
          BOBO.aiAgentButton.toggleChat(false);
        }
      });
    }

    // Clear button
    var clearBtn = document.getElementById('ai-chat-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', clearChat);
    }

    // New conversation button
    var newBtn = document.getElementById('ai-chat-new');
    if (newBtn) {
      newBtn.addEventListener('click', newConversation);
    }

    // History button
    var histBtn = document.getElementById('ai-chat-history');
    if (histBtn) {
      histBtn.addEventListener('click', showHistoryDialog);
    }

    var settingsBtn = document.getElementById('ai-chat-settings');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', function() {
        if (BOBO.aiSettingsCenter) BOBO.aiSettingsCenter.open('connections');
      });
    }

    // Tab switch detection — refresh context bar when user switches tabs
    var tabbar = document.getElementById('tabbar');
    if (tabbar) {
      tabbar.addEventListener('click', function() {
        setTimeout(function() {
          if (S.ai && S.ai.chatOpen) updateContextBar();
        }, 100);
      });
    }

    // Input key handler
    if (inputEl) {
      inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          // If command suggestions open, execute selected command
          if (cmdSuggestEl) {
            var selected = cmdSuggestEl.querySelector('.ai-command-item.selected');
            if (selected) {
              var cmdKeyEl = selected.querySelector('.cmd-key');
              if (cmdKeyEl) { executeCommand(cmdKeyEl.textContent); return; }
            }
          }
          sendMessage();
        }
        if (e.key === 'Enter' && e.shiftKey) {
          setTimeout(resizeInput, 0);
        }
        if (e.key === 'Escape') {
          if (filePickerEl) { closeFilePicker(); e.preventDefault(); }
          if (cmdSuggestEl) { closeCommandSuggestions(); e.preventDefault(); }
        }
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && cmdSuggestEl) {
          e.preventDefault();
          navigateCommands(e.key === 'ArrowDown' ? 1 : -1);
        }
      });
      inputEl.addEventListener('input', function() {
        resizeInput();
        handleInputChange();
      });
    }

    // Context bar click delegation
    if (contextBarEl) {
      contextBarEl.addEventListener('click', function(e) {
        var removeBtn = e.target.closest('.ai-pill-remove');
        if (removeBtn) {
          var pill = removeBtn.closest('.ai-context-pill');
          if (pill) {
            var fp = pill.getAttribute('data-path');
            if (fp && pill.classList.contains('ai-pill-current')) excludeAutoFileContext(fp);
            else if (fp) removeReferencedFile(fp);
          }
          return;
        }
        var addBtn = e.target.closest('.ai-context-add-btn');
        if (addBtn) { openFilePicker(); return; }
      });
    }
  }

  function resizeInput() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  // ──── Visibility ────
  function setVisible(visible) {
    ensurePanelDOM();
    // Panel visibility is now controlled by CSS opacity/transform via .chat-open class
    // This function handles content refresh when showing

    if (visible) {
      // Restore messages from state
      renderAllMessages();
      scrollToBottom();
      updateContextBar();
      if (inputEl) {
        if (inputFocusTimer) clearTimeout(inputFocusTimer);
        inputFocusTimer = setTimeout(function() {
          inputFocusTimer = null;
          if (!document.querySelector('.ai-history-overlay')) inputEl.focus();
        }, 400); // wait for slide animation
      }
    } else if (inputFocusTimer) {
      clearTimeout(inputFocusTimer);
      inputFocusTimer = null;
    }
  }

  // ──── Send Message ────
  async function sendMessage() {
    if (!inputEl) return;
    var text = inputEl.value.trim();
    if (!text) return;
    if (S.ai.chatStreaming) return; // don't send while streaming
    if (!BOBO.aiService || !BOBO.aiService.getProfileFor || !BOBO.aiService.getProfileFor('chat')) {
      if (BOBO.aiSettingsCenter) BOBO.aiSettingsCenter.open('connections');
      if (BOBO.toast) BOBO.toast.info(t('ai.chat.configureFirst'));
      return;
    }
    var generation = ++chatGeneration;
    streamRenderScheduler.cancel();
    S.ai.chatStreaming = true;

    ensureConversationId();

    inputEl.value = '';
    resizeInput();

    // Add user message
    var userMsg = {
      id: 'msg-' + Date.now(),
      role: 'user',
      content: text,
      timestamp: Date.now()
    };
    S.ai.chatMessages.push(userMsg);
    var emptyState = messagesEl && messagesEl.querySelector('.ai-chat-empty');
    if (emptyState) emptyState.remove();
    addMessageBubble(userMsg);

    // Create placeholder for AI response
    var aiMsg = {
      id: 'msg-' + (Date.now() + 1),
      role: 'assistant',
      content: '',
      timestamp: Date.now()
    };
    S.ai.chatMessages.push(aiMsg);
    streamingMsgEl = addMessageBubble(aiMsg, true);
    streamingContent = '';

    scrollToBottom();

    // Build context and send
    var context = BOBO.aiContext ? BOBO.aiContext.buildFullContext() : {};
    updateContextBar();

    // Load referenced file contents before sending
    if (S.ai.referencedFiles && S.ai.referencedFiles.length > 0) {
      var contextPolicy = S.ai.chat && S.ai.chat.context ? S.ai.chat.context : {};
      var rawMaxReferencedFiles = contextPolicy.maxReferencedFiles;
      var parsedMaxReferencedFiles = rawMaxReferencedFiles === undefined ? 4 : Number(rawMaxReferencedFiles);
      var maxReferencedFiles = Math.max(0, Math.min(20, Number.isFinite(parsedMaxReferencedFiles) ? parsedMaxReferencedFiles : 4));
      var rawReferencedFileChars = contextPolicy.referencedFileChars;
      var parsedReferencedFileChars = rawReferencedFileChars === undefined ? 5000 : Number(rawReferencedFileChars);
      var referencedFileChars = Math.max(0, Math.min(50000, Number.isFinite(parsedReferencedFileChars) ? parsedReferencedFileChars : 5000));
      var refPaths = [];
      for (var ri = 0; ri < S.ai.referencedFiles.length; ri++) {
        if (maxReferencedFiles > 0 && referencedFileChars > 0 && S.ai.referencedFiles[ri].type === 'file' && refPaths.indexOf(S.ai.referencedFiles[ri].path) < 0) {
          refPaths.push(S.ai.referencedFiles[ri].path);
          if (refPaths.length >= maxReferencedFiles) break;
        }
      }
      if (refPaths.length > 0) {
        try {
          var fileContents = await window.api.readFiles(refPaths);
          if (generation !== chatGeneration) return;
          context.referencedFilesContents = {};
          Object.keys(fileContents || {}).sort().forEach(function(filePath) {
            var content = fileContents[filePath];
            context.referencedFilesContents[filePath] = BOBO.aiPrompts && BOBO.aiPrompts.truncate
              ? BOBO.aiPrompts.truncate(content, referencedFileChars, 'middle')
              : String(content || '').slice(0, referencedFileChars);
          });
        } catch (e) {
          console.error('Error reading referenced files:', e);
        }
      }
    }
    if (generation !== chatGeneration) return;

    // Setup stream callbacks
    // Track reasoning_content separately for DeepSeek multi-turn
    var reasoningContent = '';
    BOBO.aiService.onStreamChunk(function(chunk) {
      if (generation !== chatGeneration) return;
      // chunk is {text, reasoning} from the updated IPC listener
      if (typeof chunk === 'string') {
        // backward compat
        streamingContent += chunk;
      } else {
        if (chunk.reasoning) reasoningContent += chunk.reasoning;
        if (chunk.text) streamingContent += chunk.text;
      }
      if (streamingMsgEl && streamingContent) {
        streamRenderScheduler.schedule();
      }
    });

    BOBO.aiService.onStreamEnd(function() {
      if (generation !== chatGeneration) return;
      streamRenderScheduler.cancel();
      // Finalize message
      aiMsg.content = streamingContent;
      if (reasoningContent) aiMsg.reasoning_content = reasoningContent;
      streamingMsgEl = null;
      streamingContent = '';
      reasoningContent = '';
      // Remove streaming class
      var contentEl = findContentElement(aiMsg.id);
      if (contentEl) {
        contentEl.classList.remove('streaming');
        renderAssistantContent(contentEl, aiMsg.content, false);
      }
      // Persist chat history after message completes
      saveChatHistory();
    });

    BOBO.aiService.onStreamError(function(err) {
      if (generation !== chatGeneration) return;
      streamRenderScheduler.cancel();
      if (streamingMsgEl) {
        streamingMsgEl.querySelector('.ai-msg-content').innerHTML =
          '<span style="color:var(--red);">' + escHtml(errorText(err)) + '</span>';
        renderMessageError(streamingMsgEl.querySelector('.ai-msg-content'), errorText(err));
      }
      aiMsg.content = '[' + errorText(err) + ']';
      streamingMsgEl = null;
      streamingContent = '';
      reasoningContent = '';
    });

    var sent;
    try {
      sent = await BOBO.aiService.sendChat(text, context);
    } catch (sendError) {
      sent = { success: false, code: sendError && sendError.code || 'ai.error.requestFailed' };
    }
    if (generation !== chatGeneration) return;
    if (!sent || sent.success === false) {
      streamRenderScheduler.cancel();
      S.ai.chatStreaming = false;
      if (streamingMsgEl) {
        streamingMsgEl.querySelector('.ai-msg-content').innerHTML =
          '<span style="color:var(--red);">' + escHtml(errorText(sent)) + '</span>';
        renderMessageError(streamingMsgEl.querySelector('.ai-msg-content'), errorText(sent));
      }
      aiMsg.content = '[' + errorText(sent) + ']';
      streamingMsgEl = null;
      streamingContent = '';
      reasoningContent = '';
      saveChatHistory();
    }
  }

  // ──── Render Messages ────
  function addMessageBubble(msg, isStreaming) {
    if (!messagesEl) return null;

    var bubble = document.createElement('div');
    bubble.className = 'ai-msg-bubble ai-msg-' + msg.role;
    bubble.setAttribute('data-msg-id', msg.id);

    var roleLabel = document.createElement('div');
    roleLabel.className = 'ai-msg-role';
    if (msg.role === 'user') bindText(roleLabel, 'You');
    else roleLabel.textContent = 'AI';

    var content = document.createElement('div');
    content.className = 'ai-msg-content' + (isStreaming ? ' streaming' : '');

    if (msg.role === 'user') {
      content.textContent = msg.content;
    } else {
      // Render AI content with code blocks
      if (isStreaming) {
        content.innerHTML = '<span class="ai-cursor-blink">▌</span>';
      } else {
        content.innerHTML = renderMarkdown(msg.content);
        content.classList.remove('streaming');
      }
      renderAssistantContent(content, isStreaming ? '' : msg.content, isStreaming);
    }

    bubble.appendChild(roleLabel);
    bubble.appendChild(content);
    messagesEl.appendChild(bubble);
    return bubble;
  }

  function renderStreamingContent(bubble, text) {
    var contentEl = bubble.querySelector('.ai-msg-content');
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(text) + '<span class="ai-cursor-blink">▌</span>';
      renderAssistantContent(contentEl, text, true);
    }
  }

  function renderAssistantContent(contentEl, text, streaming) {
    if (BOBO.aiMarkdown && BOBO.aiMarkdown.render) {
      BOBO.aiMarkdown.render(contentEl, text, { streaming: streaming });
      return;
    }
    contentEl.textContent = text || '';
  }

  function renderMessageError(contentEl, message) {
    if (!contentEl) return;
    contentEl.replaceChildren();
    var error = document.createElement('span');
    error.className = 'ai-message-error';
    error.textContent = message;
    contentEl.appendChild(error);
  }

  function findContentElement(msgId) {
    if (!messagesEl) return null;
    var bubble = messagesEl.querySelector('[data-msg-id="' + msgId + '"]');
    return bubble ? bubble.querySelector('.ai-msg-content') : null;
  }

  function renderAllMessages() {
    if (!messagesEl) return;
    messagesEl.innerHTML = '';
    updateChatModelLabel();
    if (!S.ai.chatMessages.length) {
      renderEmptyState();
      return;
    }
    for (var i = 0; i < S.ai.chatMessages.length; i++) {
      addMessageBubble(S.ai.chatMessages[i], false);
    }
  }

  function updateChatModelLabel() {
    var label = document.getElementById('ai-chat-model-label');
    if (!label) return;
    var profile = BOBO.aiService && BOBO.aiService.getProfileFor ? BOBO.aiService.getProfileFor('chat') : null;
    label.textContent = profile ? profile.name : t('ai.chat.noProfile');
    label.dataset.state = profile ? 'ready' : 'unconfigured';
  }

  function renderEmptyState() {
    var profile = BOBO.aiService && BOBO.aiService.getProfileFor ? BOBO.aiService.getProfileFor('chat') : null;
    var empty = document.createElement('div');
    empty.className = 'ai-chat-empty';

    var mark = document.createElement('div');
    mark.className = 'ai-chat-empty-mark';
    mark.textContent = 'AI';

    var title = document.createElement('h2');
    title.textContent = t(profile ? 'ai.chat.empty.title' : 'ai.chat.noProfile');
    empty.append(mark, title);

    if (!profile) {
      var configure = document.createElement('button');
      configure.type = 'button';
      configure.className = 'ss-btn ss-btn-primary';
      configure.textContent = t('ai.chat.configure');
      configure.addEventListener('click', function() {
        if (BOBO.aiSettingsCenter) BOBO.aiSettingsCenter.open('connections');
      });
      empty.appendChild(configure);
      messagesEl.appendChild(empty);
      return;
    }

    var actions = document.createElement('div');
    actions.className = 'ai-chat-starters';
    [
      'ai.chat.quick.clearCache',
      'ai.chat.quick.diagnose',
      'ai.chat.quick.explainSelection'
    ].forEach(function(key) {
      var action = document.createElement('button');
      action.type = 'button';
      action.textContent = t(key);
      action.addEventListener('click', function() {
        inputEl.value = t(key);
        resizeInput();
        sendMessage();
      });
      actions.appendChild(action);
    });
    empty.appendChild(actions);
    messagesEl.appendChild(empty);
  }

  // ──── Simple Markdown Rendering ────
  function renderMarkdown(text) {
    if (!text) return '';

    var html = escHtml(text);

    // Code blocks: ```lang ... ```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(match, lang, code) {
      var langLabel = lang ? '<div class="ai-code-lang">' + escHtml(lang) + '</div>' : '';
      return '<div class="ai-code-block">' + langLabel + '<pre><code>' + escHtml(code.trim()) + '</code></pre></div>';
    });

    // Inline code: `...`
    html = html.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');

    // Bold: **...**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic: *...*
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  // ──── Context Bar ────
  function updateContextBar() {
    if (!contextBarEl) return;
    contextBarEl.innerHTML = '';

    // Show current active file unless this conversation explicitly removed it.
    var activeCtx = BOBO.aiContext ? BOBO.aiContext.getCurrentFileContext() : null;
    if (activeCtx && activeCtx.path) {
      var currentPill = document.createElement('span');
      currentPill.className = 'ai-context-pill ai-pill-current';
      currentPill.setAttribute('data-path', activeCtx.path);
      bindAttribute(currentPill, 'title', '{path} (current file — auto-included)', { path: activeCtx.path });

      var cIcon = document.createElement('span');
      cIcon.className = 'ai-pill-icon';
      cIcon.innerHTML = BOBO.icons.fileText;

      var cName = document.createElement('span');
      cName.className = 'ai-pill-name';
      cName.textContent = activeCtx.name;

      var cRemove = document.createElement('button');
      cRemove.type = 'button';
      cRemove.className = 'ai-pill-remove';
      cRemove.innerHTML = BOBO.icons.close;
      cRemove.title = t('ai.chat.context.removeCurrent');
      cRemove.setAttribute('aria-label', t('ai.chat.context.removeCurrent'));
      currentPill.appendChild(cIcon);
      currentPill.appendChild(cName);
      currentPill.appendChild(cRemove);
      contextBarEl.appendChild(currentPill);
    }

    // User-referenced files (skip the current file if it's also in the list)
    var files = S.ai.referencedFiles || [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      // Skip if same as current active file (already shown above)
      if (activeCtx && f.path === activeCtx.path) continue;

      var pill = document.createElement('span');
      pill.className = 'ai-context-pill';
      pill.setAttribute('data-path', f.path);

      var icon = document.createElement('span');
      icon.className = 'ai-pill-icon';
      icon.innerHTML = f.type === 'folder' ? BOBO.icons.folder : BOBO.icons.file;

      var nameEl = document.createElement('span');
      nameEl.className = 'ai-pill-name';
      nameEl.textContent = f.name;

      var remove = document.createElement('span');
      remove.className = 'ai-pill-remove';
      remove.innerHTML = BOBO.icons.close;

      pill.appendChild(icon);
      pill.appendChild(nameEl);
      pill.appendChild(remove);
      contextBarEl.appendChild(pill);
    }

    var addBtn = document.createElement('button');
    addBtn.className = 'ai-context-add-btn';
    bindText(addBtn, 'Add Context', null, { prefix: '+ ' });
    contextBarEl.appendChild(addBtn);
  }

  // ──── Referenced File Management ────
  function addReferencedFile(filePath, fileName, fileType) {
    if (!S.ai.referencedFiles) S.ai.referencedFiles = [];
    S.ai.excludedAutoContextPaths = (S.ai.excludedAutoContextPaths || []).filter(function(path) { return path !== filePath; });
    for (var i = 0; i < S.ai.referencedFiles.length; i++) {
      if (S.ai.referencedFiles[i].path === filePath) return;
    }
    S.ai.referencedFiles.push({
      path: filePath,
      name: fileName || filePath.split(/[/\\]/).pop(),
      type: fileType || 'file'
    });
    updateContextBar();
  }

  function removeReferencedFile(filePath) {
    if (!S.ai.referencedFiles) return;
    for (var i = 0; i < S.ai.referencedFiles.length; i++) {
      if (S.ai.referencedFiles[i].path === filePath) {
        S.ai.referencedFiles.splice(i, 1);
        break;
      }
    }
    updateContextBar();
  }

  function excludeAutoFileContext(filePath) {
    if (!filePath) return;
    if (!S.ai.excludedAutoContextPaths) S.ai.excludedAutoContextPaths = [];
    if (S.ai.excludedAutoContextPaths.indexOf(filePath) < 0) S.ai.excludedAutoContextPaths.push(filePath);
    S.ai.autoContextDisabled = true;
    S.ai.referencedFiles = (S.ai.referencedFiles || []).filter(function(file) { return file.path !== filePath; });
    updateContextBar();
    saveChatHistory();
  }

  // ──── File Picker Dropdown ────
  function openFilePicker(filterText) {
    closeFilePicker();
    closeCommandSuggestions();
    if (!S.workspaceRoot) return;
    loadFilePickerTree(filterText);
  }

  function closeFilePicker() {
    if (filePickerEl && filePickerEl.parentNode) {
      filePickerEl.parentNode.removeChild(filePickerEl);
    }
    filePickerEl = null;
  }

  async function loadFilePickerTree(filterText) {
    try {
      var tree = await window.api.readTree(S.workspaceRoot);
      if (!tree) return;
      renderFilePicker(tree, filterText);
    } catch (e) {
      console.error('File picker load error:', e);
    }
  }

  function flattenTree(node, result, pathPrefix) {
    if (!node) return result || [];
    result = result || [];
    pathPrefix = pathPrefix || '';
    if (node.type === 'file' && node.name && node.path) {
      var dp = pathPrefix ? pathPrefix + '/' + node.name : node.name;
      result.push({ path: node.path, name: node.name, displayPath: dp, type: 'file' });
    }
    if (node.children) {
      var np = pathPrefix ? pathPrefix + '/' + node.name : node.name;
      for (var i = 0; i < node.children.length; i++) {
        flattenTree(node.children[i], result, np);
      }
    }
    return result;
  }

  function renderFilePicker(tree, filterText) {
    closeFilePicker();
    var allFiles = flattenTree(tree, []);

    filterText = (filterText || '').toLowerCase();
    var filtered = allFiles;
    if (filterText) {
      filtered = [];
      for (var i = 0; i < allFiles.length; i++) {
        if (allFiles[i].name.toLowerCase().indexOf(filterText) !== -1 ||
            allFiles[i].displayPath.toLowerCase().indexOf(filterText) !== -1) {
          filtered.push(allFiles[i]);
        }
      }
    }
    if (filtered.length > 500) filtered = filtered.slice(0, 500);

    filePickerEl = document.createElement('div');
    filePickerEl.className = 'ai-file-picker';

    var searchWrap = document.createElement('div');
    searchWrap.className = 'ai-file-picker-search';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    bindAttribute(searchInput, 'placeholder', 'Search files... ({count} total)', { count: allFiles.length });
    searchInput.value = filterText;
    searchInput.addEventListener('input', function() {
      renderFilePicker(tree, searchInput.value);
    });
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { closeFilePicker(); }
      if (e.key === 'Enter') { e.preventDefault(); }
    });
    searchWrap.appendChild(searchInput);
    filePickerEl.appendChild(searchWrap);

    var list = document.createElement('div');
    list.className = 'ai-file-picker-list';

    if (filtered.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'ai-file-picker-empty';
      if (filterText) bindText(empty, 'No files match "{query}"', { query: filterText });
      else bindText(empty, 'No files in workspace');
      list.appendChild(empty);
    } else {
      for (var j = 0; j < filtered.length; j++) {
        (function(entry) {
          var item = document.createElement('div');
          item.className = 'ai-file-picker-item';
          item.setAttribute('data-path', entry.path);

          var ico = document.createElement('span');
          ico.className = 'fp-icon';
          ico.innerHTML = BOBO.icons.file;

          var nm = document.createElement('span');
          nm.className = 'fp-name';
          nm.textContent = entry.name;

          var pp = document.createElement('span');
          pp.className = 'fp-path';
          pp.textContent = entry.displayPath;

          item.appendChild(ico);
          item.appendChild(nm);
          item.appendChild(pp);

          var isAdded = false;
          var refs = S.ai.referencedFiles || [];
          for (var k = 0; k < refs.length; k++) {
            if (refs[k].path === entry.path) { isAdded = true; break; }
          }
          if (isAdded) {
            var added = document.createElement('span');
            added.className = 'fp-added';
            added.innerHTML = BOBO.icons.check;
            item.appendChild(added);
          }

          item.addEventListener('click', function() {
            addReferencedFile(entry.path, entry.name, entry.type);
            closeFilePicker();
          });

          list.appendChild(item);
        })(filtered[j]);
      }
    }

    filePickerEl.appendChild(list);

    positionPickerAboveInput();

    var closeHandler = function(e) {
      if (filePickerEl && !filePickerEl.contains(e.target)) {
        closeFilePicker();
        document.removeEventListener('mousedown', closeHandler, true);
      }
    };
    setTimeout(function() {
      document.addEventListener('mousedown', closeHandler, true);
    }, 0);

    document.body.appendChild(filePickerEl);
    setTimeout(function() { searchInput.focus(); searchInput.select(); }, 50);
  }

  function positionPickerAboveInput() {
    if (!filePickerEl) return;
    var inputRow = document.querySelector('.ai-chat-input-row');
    if (!inputRow) return;
    var rect = inputRow.getBoundingClientRect();
    var pw = 320;
    var left = Math.max(8, rect.left);
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    var top = rect.top - 8;
    if (top < 8) top = 8;
    filePickerEl.style.left = left + 'px';
    filePickerEl.style.top = top + 'px';
    filePickerEl.style.width = pw + 'px';
  }

  // ──── Command Suggestions ────
  var COMMANDS = [
    { key: '/file', desc: 'Search and add a file to context' },
    { key: '/clear', desc: 'Clear all referenced files' }
  ];

  function showCommandSuggestions(filterText) {
    closeCommandSuggestions();
    closeFilePicker();

    var matched = COMMANDS;
    if (filterText && filterText.length > 1) {
      var lower = filterText.toLowerCase();
      matched = [];
      for (var i = 0; i < COMMANDS.length; i++) {
        if (COMMANDS[i].key.indexOf(lower) === 0) matched.push(COMMANDS[i]);
      }
    }
    if (matched.length === 0) return;

    cmdSuggestEl = document.createElement('div');
    cmdSuggestEl.className = 'ai-command-suggestions';

    for (var j = 0; j < matched.length; j++) {
      (function(cmd) {
        var item = document.createElement('div');
        item.className = 'ai-command-item';
        if (j === 0) item.classList.add('selected');

        var keySpan = document.createElement('span');
        keySpan.className = 'cmd-key';
        keySpan.textContent = cmd.key;

        var descSpan = document.createElement('span');
        descSpan.className = 'cmd-desc';
        bindText(descSpan, cmd.desc);

        item.appendChild(keySpan);
        item.appendChild(descSpan);

        item.addEventListener('click', function() { executeCommand(cmd.key); });
        cmdSuggestEl.appendChild(item);
      })(matched[j]);
    }

    var inputRow = document.querySelector('.ai-chat-input-row');
    if (inputRow) {
      var rect = inputRow.getBoundingClientRect();
      cmdSuggestEl.style.left = Math.max(8, rect.left) + 'px';
      cmdSuggestEl.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    }

    var closeHandler = function(e) {
      if (cmdSuggestEl && !cmdSuggestEl.contains(e.target) && e.target !== inputEl) {
        closeCommandSuggestions();
        document.removeEventListener('mousedown', closeHandler, true);
      }
    };
    setTimeout(function() {
      document.addEventListener('mousedown', closeHandler, true);
    }, 0);

    document.body.appendChild(cmdSuggestEl);
  }

  function closeCommandSuggestions() {
    if (cmdSuggestEl && cmdSuggestEl.parentNode) {
      cmdSuggestEl.parentNode.removeChild(cmdSuggestEl);
    }
    cmdSuggestEl = null;
  }

  function executeCommand(cmdKey) {
    closeCommandSuggestions();
    if (!inputEl) return;
    if (cmdKey === '/file') {
      var val = inputEl.value;
      var searchText = '';
      var fi = val.indexOf('/file');
      if (fi !== -1) searchText = val.substring(fi + 6).trim();
      inputEl.value = '';
      resizeInput();
      openFilePicker(searchText);
    } else if (cmdKey === '/clear') {
      S.ai.referencedFiles = [];
      updateContextBar();
      inputEl.value = inputEl.value.replace(/\/clear\b\s*/g, '').trim();
      resizeInput();
    }
  }

  function navigateCommands(direction) {
    if (!cmdSuggestEl) return;
    var items = cmdSuggestEl.querySelectorAll('.ai-command-item');
    var selIdx = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].classList.contains('selected')) { items[i].classList.remove('selected'); selIdx = i; break; }
    }
    var next = selIdx + direction;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    items[next].classList.add('selected');
  }

  function handleInputChange() {
    if (!inputEl) return;
    var val = inputEl.value;
    var lastWord = val.split(/\s+/).pop() || '';
    if (lastWord === '/' || (lastWord.startsWith('/') && lastWord.indexOf(' ') === -1)) {
      showCommandSuggestions(lastWord);
    } else {
      closeCommandSuggestions();
    }
  }

  // ──── Chat History Persistence ────
  async function loadChatHistory() {
    if (!S.workspaceRoot) return;
    try {
      var history = await window.api.loadChatHistory(S.workspaceRoot);
      if (!history) return;

      // Migrate old format: {messages, referencedFiles} → new conversations format
      if (history.messages && history.messages.length > 0 && !history.conversations) {
        var oldConv = {
          id: 'conv-' + Date.now(),
          title: '',
          messages: history.messages,
          referencedFiles: history.referencedFiles || [],
          excludedAutoContextPaths: [],
          autoContextDisabled: false,
          createdAt: Date.now()
        };
        history.conversations = [oldConv];
        history.currentConversationId = oldConv.id;
        // Clear old fields so format is clean on save
        delete history.messages;
        delete history.referencedFiles;
      }

      // Load conversations array
      S.ai.conversations = history.conversations || [];
      S.ai.currentConversationId = history.currentConversationId || '';

      // Restore current conversation
      if (S.ai.currentConversationId && S.ai.conversations.length > 0) {
        for (var i = 0; i < S.ai.conversations.length; i++) {
          if (S.ai.conversations[i].id === S.ai.currentConversationId) {
            var conv = S.ai.conversations[i];
            S.ai.chatMessages = conv.messages ? conv.messages.slice() : [];
            S.ai.referencedFiles = conv.referencedFiles ? conv.referencedFiles.slice() : [];
            S.ai.excludedAutoContextPaths = conv.excludedAutoContextPaths ? conv.excludedAutoContextPaths.slice() : [];
            S.ai.autoContextDisabled = conv.autoContextDisabled === true;
            break;
          }
        }
      }
      // If no current conversation, start fresh
      if (!S.ai.currentConversationId && S.ai.conversations.length > 0) {
        // Load the last conversation
        var last = S.ai.conversations[S.ai.conversations.length - 1];
        S.ai.currentConversationId = last.id;
        S.ai.chatMessages = last.messages ? last.messages.slice() : [];
        S.ai.referencedFiles = last.referencedFiles ? last.referencedFiles.slice() : [];
        S.ai.excludedAutoContextPaths = last.excludedAutoContextPaths ? last.excludedAutoContextPaths.slice() : [];
        S.ai.autoContextDisabled = last.autoContextDisabled === true;
      }

      renderAllMessages();
      updateContextBar();
      scrollToBottom();
    } catch (e) {
      console.error('Error loading chat history:', e);
    }
  }

  async function saveChatHistory() {
    if (!S.workspaceRoot) return;
    // Sync current messages to the active conversation before saving
    if (S.ai.currentConversationId && (S.ai.chatMessages.length > 0 || (S.ai.referencedFiles || []).length > 0)) {
      var active = null;
      for (var i = 0; i < (S.ai.conversations || []).length; i++) {
        if (S.ai.conversations[i].id === S.ai.currentConversationId) {
          active = S.ai.conversations[i]; break;
        }
      }
      if (!active) {
        active = { id: S.ai.currentConversationId, title: '', messages: [], referencedFiles: [], excludedAutoContextPaths: [], autoContextDisabled: false, createdAt: Date.now() };
        S.ai.conversations.push(active);
      }
      active.messages = S.ai.chatMessages.slice();
      active.referencedFiles = (S.ai.referencedFiles || []).slice();
      active.excludedAutoContextPaths = (S.ai.excludedAutoContextPaths || []).slice();
      active.autoContextDisabled = S.ai.autoContextDisabled === true;
      // Auto-title
      if (!active.title) {
        for (var j = 0; j < active.messages.length; j++) {
          if (active.messages[j].role === 'user') {
            active.title = active.messages[j].content.substring(0, 60);
            break;
          }
        }
      }
    }
    // Remove empty conversations
    S.ai.conversations = (S.ai.conversations || []).filter(function(c) {
      return (c.messages && c.messages.length > 0) || (c.referencedFiles && c.referencedFiles.length > 0);
    });
    try {
      await window.api.saveChatHistory(S.workspaceRoot, {
        conversations: S.ai.conversations,
        currentConversationId: S.ai.currentConversationId
      });
    } catch (e) {
      console.error('Error saving chat history:', e);
    }
  }

  // ──── Conversation Management ────
  function ensureConversationId() {
    if (!S.ai.currentConversationId) {
      S.ai.currentConversationId = 'conv-' + Date.now();
    }
    return S.ai.currentConversationId;
  }

  function saveCurrentConversation() {
    if (!S.ai.chatMessages || S.ai.chatMessages.length === 0) return;
    var convId = ensureConversationId();
    var existing = null;
    for (var i = 0; i < (S.ai.conversations || []).length; i++) {
      if (S.ai.conversations[i].id === convId) { existing = S.ai.conversations[i]; break; }
    }
    if (!existing) {
      existing = { id: convId, title: '', messages: [], referencedFiles: [], excludedAutoContextPaths: [], autoContextDisabled: false, createdAt: Date.now() };
      S.ai.conversations.push(existing);
    }
    existing.messages = S.ai.chatMessages.slice();
    existing.referencedFiles = (S.ai.referencedFiles || []).slice();
    existing.excludedAutoContextPaths = (S.ai.excludedAutoContextPaths || []).slice();
    existing.autoContextDisabled = S.ai.autoContextDisabled === true;
    // Auto-title: first user message, first 60 chars
    if (!existing.title) {
      for (var j = 0; j < existing.messages.length; j++) {
        if (existing.messages[j].role === 'user') {
          existing.title = existing.messages[j].content.substring(0, 60);
          break;
        }
      }
      if (!existing.title) existing.title = 'New conversation';
    }
    saveChatHistory();
  }

  function newConversation() {
    chatGeneration += 1;
    streamRenderScheduler.cancel();
    if (S.ai.chatStreaming && BOBO.aiService) BOBO.aiService.cancelStream();
    // Save current conversation before starting new
    saveCurrentConversation();
    S.ai.chatMessages = [];
    S.ai.referencedFiles = [];
    S.ai.excludedAutoContextPaths = [];
    S.ai.autoContextDisabled = false;
    S.ai.currentConversationId = '';
    renderAllMessages();
    updateContextBar();
    saveChatHistory();
    if (inputEl) inputEl.focus();
  }

  function switchConversation(id) {
    chatGeneration += 1;
    streamRenderScheduler.cancel();
    if (S.ai.chatStreaming && BOBO.aiService) BOBO.aiService.cancelStream();
    if (id === S.ai.currentConversationId) return;
    // Save current first
    saveCurrentConversation();
    // Load target
    var conv = null;
    for (var i = 0; i < (S.ai.conversations || []).length; i++) {
      if (S.ai.conversations[i].id === id) { conv = S.ai.conversations[i]; break; }
    }
    if (!conv) return;
    S.ai.currentConversationId = conv.id;
    S.ai.chatMessages = conv.messages ? conv.messages.slice() : [];
    S.ai.referencedFiles = conv.referencedFiles ? conv.referencedFiles.slice() : [];
    S.ai.excludedAutoContextPaths = conv.excludedAutoContextPaths ? conv.excludedAutoContextPaths.slice() : [];
    S.ai.autoContextDisabled = conv.autoContextDisabled === true;
    renderAllMessages();
    updateContextBar();
    scrollToBottom();
    closeHistoryDialog();
  }

  function deleteConversation(id) {
    if (!S.ai.conversations) return;
    var idx = -1;
    for (var i = 0; i < S.ai.conversations.length; i++) {
      if (S.ai.conversations[i].id === id) { idx = i; break; }
    }
    if (idx === -1) return;
    S.ai.conversations.splice(idx, 1);
    // If deleting active conversation, start fresh
    if (S.ai.currentConversationId === id) {
      S.ai.chatMessages = [];
      S.ai.referencedFiles = [];
      S.ai.excludedAutoContextPaths = [];
      S.ai.autoContextDisabled = false;
      S.ai.currentConversationId = '';
      renderAllMessages();
      updateContextBar();
    }
    saveChatHistory();
    // Refresh the history dialog if open
    var overlay = document.querySelector('.ai-history-overlay');
    if (overlay) { overlay.remove(); showHistoryDialog(true); }
  }

  function showHistoryDialog(preservePreviousFocus) {
    var old = document.querySelector('.ai-history-overlay');
    if (old) { closeHistoryDialog(); return; }

    saveCurrentConversation(); // save before viewing
    if (inputFocusTimer) {
      clearTimeout(inputFocusTimer);
      inputFocusTimer = null;
    }
    if (preservePreviousFocus !== true) historyPreviousFocus = document.activeElement;

    var overlay = document.createElement('div');
    overlay.className = 'ai-history-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'ai-history-title');

    var card = document.createElement('div');
    card.className = 'ai-history-card';

    // Header
    var header = document.createElement('div');
    header.className = 'ai-history-header';
    var title = document.createElement('span');
    title.id = 'ai-history-title';
    title.innerHTML = BOBO.icons.history;
    var titleText = document.createElement('span');
    bindText(titleText, 'Conversation history', null, { prefix: ' ' });
    title.appendChild(titleText);
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ai-history-close';
    closeBtn.innerHTML = BOBO.icons.close;
    bindAttribute(closeBtn, 'title', 'Close');
    bindAttribute(closeBtn, 'aria-label', 'Close');
    closeBtn.onclick = closeHistoryDialog;
    header.appendChild(title);
    header.appendChild(closeBtn);
    card.appendChild(header);

    // List
    var list = document.createElement('div');
    list.className = 'ai-history-list';

    var convs = S.ai.conversations || [];
    if (convs.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'ai-history-empty';
      bindText(empty, 'No saved conversations yet.\nStart a chat and it will appear here.');
      list.appendChild(empty);
    } else {
      // Sort newest first
      var sorted = convs.slice().sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      for (var i = 0; i < sorted.length; i++) {
        (function(conv) {
          var item = document.createElement('div');
          item.className = 'ai-history-item';
          item.setAttribute('role', 'button');
          item.tabIndex = 0;
          if (conv.id === S.ai.currentConversationId) item.classList.add('active');

          var hTitle = document.createElement('span');
          hTitle.className = 'h-title';
          if (!conv.title) bindText(hTitle, 'Untitled');
          else if (conv.title === 'New conversation') bindText(hTitle, 'New conversation');
          else hTitle.textContent = conv.title;

          var hMeta = document.createElement('span');
          hMeta.className = 'h-meta';
          var msgCount = conv.messages ? conv.messages.length : 0;
          bindText(hMeta, '{count} messages', { count: msgCount });

          var delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'h-delete';
          delBtn.innerHTML = BOBO.icons.trash;
          bindAttribute(delBtn, 'title', 'Delete conversation');
          delBtn.onclick = function(e) {
            e.stopPropagation();
            deleteConversation(conv.id);
          };

          item.appendChild(hTitle);
          item.appendChild(hMeta);
          item.appendChild(delBtn);

          item.onclick = function() { switchConversation(conv.id); };
          item.onkeydown = function(event) {
            if (event.target !== item || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            switchConversation(conv.id);
          };
          list.appendChild(item);
        })(sorted[i]);
      }
    }

    card.appendChild(list);
    overlay.appendChild(card);

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeHistoryDialog();
    });
    overlay.addEventListener('keydown', function(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeHistoryDialog();
        return;
      }
      if (event.key !== 'Tab') return;
      var focusable = Array.prototype.filter.call(overlay.querySelectorAll('button:not([disabled]), [tabindex]:not([tabindex="-1"])'), function(node) {
        return node.offsetParent !== null;
      });
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    document.body.appendChild(overlay);
    var firstItem = list.querySelector('.ai-history-item');
    setTimeout(function() { (firstItem || closeBtn).focus(); }, 0);
  }

  function closeHistoryDialog() {
    var overlay = document.querySelector('.ai-history-overlay');
    if (overlay) overlay.remove();
    var restoreFocus = historyPreviousFocus;
    historyPreviousFocus = null;
    if (restoreFocus && restoreFocus.focus) {
      setTimeout(function() {
        if (restoreFocus.isConnected) restoreFocus.focus();
      }, 0);
    }
  }

  // ──── Clear Chat ────
  function clearChat() {
    chatGeneration += 1;
    streamRenderScheduler.cancel();
    if (S.ai.chatStreaming && BOBO.aiService) BOBO.aiService.cancelStream();
    saveCurrentConversation();
    S.ai.chatMessages = [];
    S.ai.referencedFiles = [];
    S.ai.excludedAutoContextPaths = [];
    S.ai.autoContextDisabled = false;
    S.ai.currentConversationId = '';
    streamingContent = '';
    streamingMsgEl = null;
    renderAllMessages();
    updateContextBar();
    saveChatHistory();
  }

  // ──── Scroll ────
  function scrollToBottom() {
    if (messagesEl) {
      setTimeout(function() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }, 10);
    }
  }

  // ──── Helpers ────
  function escHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ──── Chat Resizer ────
  function setupChatResizer() {
    if (BOBO.workbench) BOBO.workbench.init();
  }

  // ──── Init ────
  function init() {
    ensurePanelDOM();
    setupChatResizer();
    loadChatHistory();
    // Reload history when workspace changes
    if (window.api && window.api.onWorkspaceOpened) {
      window.api.onWorkspaceOpened(function() { loadChatHistory(); });
    }
    global.addEventListener('bobo:workspace-changed', function() { loadChatHistory(); });
    if (BOBO.i18n && BOBO.i18n.onChange) {
      BOBO.i18n.onChange(function() {
        updateChatModelLabel();
        if (!S.ai.chatMessages.length) renderAllMessages();
      });
    }
  }

  BOBO.aiChatPanel = {
    init: init,
    setVisible: setVisible,
    sendMessage: sendMessage,
    clearChat: clearChat,
    updateContextBar: updateContextBar,
    addReferencedFile: addReferencedFile,
    removeReferencedFile: removeReferencedFile,
    excludeAutoFileContext: excludeAutoFileContext,
    openFilePicker: openFilePicker,
    saveChatHistory: saveChatHistory
  };
})(window);
