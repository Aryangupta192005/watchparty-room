'use strict';

const socket = io({ reconnection: true, reconnectionAttempts: Infinity });
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const homeView = $('#homeView');
const roomView = $('#roomView');
const displayNameInput = $('#displayName');
const roomCodeInput = $('#roomCode');
const createRoomBtn = $('#createRoomBtn');
const joinRoomForm = $('#joinRoomForm');
const roomCodeLabel = $('#roomCodeLabel');
const copyLinkBtn = $('#copyLinkBtn');
const sharedVideo = $('#sharedVideo');
const emptyStage = $('#emptyStage');
const stageStatus = $('#stageStatus');
const nowPlayingName = $('#nowPlayingName');
const syncStatus = $('#syncStatus');
const syncNotice = $('#syncNotice');
const syncNoticeText = $('#syncNoticeText');
const fileInput = $('#fileInput');
const uploadProgressText = $('#uploadProgressText');
const chatMessages = $('#chatMessages');
const chatForm = $('#chatForm');
const chatInput = $('#chatInput');
const roomFilesList = $('#roomFilesList');
const roomPeopleList = $('#roomPeopleList');
const toast = $('#toast');

let currentRoomId = null;
let roomState = { members: [], files: [], media: null, playback: null, messages: [] };
let isJoined = false;
let joinInFlightFor = null;
let suppressMediaEventsUntil = 0;
let toastTimeout;
let rateResetTimeout;
let isUploading = false;

function userName() {
  const entered = (displayNameInput?.value || '').trim().slice(0, 24);
  const saved = (localStorage.getItem('watchparty-name') || '').trim().slice(0, 24);
  const name = entered || saved || `Guest-${Math.floor(100 + Math.random() * 900)}`;
  localStorage.setItem('watchparty-name', name);
  if (displayNameInput) displayNameInput.value = name;
  return name;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2700);
}

function showSyncNotice(message) {
  syncNoticeText.textContent = message;
  syncNotice.hidden = false;
}

function hideSyncNotice() { syncNotice.hidden = true; }

function roomIdFromInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      const match = url.pathname.match(/\/room\/([A-Za-z0-9_-]{4,32})/);
      return match ? match[1].toUpperCase() : null;
    }
  } catch { /* handle as a raw code below */ }
  const pathMatch = value.match(/(?:^|\/)room\/([A-Za-z0-9_-]{4,32})(?:\/|$|\?|#)/i);
  if (pathMatch) return pathMatch[1].toUpperCase();
  const code = value.replace(/\s/g, '').replace(/[^a-zA-Z0-9_-]/g, '');
  return /^[A-Za-z0-9_-]{4,32}$/.test(code) ? code.toUpperCase() : null;
}

function setView(inRoom) {
  homeView.hidden = inRoom;
  roomView.hidden = !inRoom;
  document.body.classList.toggle('in-room', inRoom);
  window.scrollTo(0, 0);
}

function requestRoomJoin(roomId) {
  if (!roomId || !socket.connected || isJoined || joinInFlightFor === roomId) return;
  joinInFlightFor = roomId;
  socket.emit('room:join', { roomId, name: userName() }, response => {
    if (joinInFlightFor === roomId) joinInFlightFor = null;
    // Ignore an old acknowledgement if the user navigated to another room meanwhile.
    if (currentRoomId !== roomId) return;
    if (!response?.ok) {
      showToast(response?.error || 'Could not join this room.');
      return;
    }
    isJoined = true;
    currentRoomId = response.roomId;
    roomCodeLabel.textContent = response.roomId;
    setView(true);
    syncStatus.textContent = 'Connected to room';
  });
}

function enterRoom(roomId) {
  if (!roomId) return;
  currentRoomId = roomId;
  isJoined = false;
  joinInFlightFor = null;
  roomState = { members: [], files: [], media: null, playback: null, messages: [] };
  roomCodeLabel.textContent = roomId;
  setView(true);
  renderFiles();
  renderPeople();
  renderChat();
  requestRoomJoin(roomId);
}

function navigateToRoom(roomId) {
  history.pushState({ roomId }, '', `/room/${encodeURIComponent(roomId)}`);
  enterRoom(roomId);
}

function resetHomeUrl(updateHistory = true) {
  if (currentRoomId && socket.connected) socket.emit('room:leave');
  if (updateHistory) history.pushState({}, '', '/');
  else history.replaceState({}, '', '/');
  currentRoomId = null;
  isJoined = false;
  joinInFlightFor = null;
  roomState = { members: [], files: [], media: null, playback: null, messages: [] };
  setView(false);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'File';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function safeTextElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function formatTime(epoch) {
  try { return new Date(epoch).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

function renderChat() {
  chatMessages.replaceChildren();
  if (!roomState.messages.length) {
    const welcome = document.createElement('div');
    welcome.className = 'welcome-message';
    welcome.append(safeTextElement('span', 'welcome-emoji', '🍿'));
    welcome.append(safeTextElement('strong', '', 'Welcome to the lounge'));
    welcome.append(safeTextElement('p', '', 'Say hi, share a reaction, or call dibs on the next snack.'));
    chatMessages.append(welcome);
  } else {
    for (const message of roomState.messages) appendChatMessage(message, false);
  }
  $('#chatCount').textContent = String(roomState.messages.length);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendChatMessage(message, shouldScroll = true) {
  // All user content is inserted as text, never interpreted as HTML.
  const wrapper = document.createElement('article');
  wrapper.className = 'chat-message';
  const firstChar = Array.from(message.name || 'G')[0]?.toUpperCase() || 'G';
  wrapper.append(safeTextElement('span', 'chat-avatar', firstChar));
  const content = document.createElement('div');
  content.className = 'chat-message-content';
  const head = document.createElement('div');
  head.className = 'chat-message-head';
  head.append(safeTextElement('strong', '', message.name || 'Guest'));
  head.append(safeTextElement('time', '', formatTime(message.at)));
  content.append(head);
  content.append(safeTextElement('p', '', message.text || ''));
  wrapper.append(content);
  chatMessages.append(wrapper);
  if (shouldScroll) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderFiles() {
  roomFilesList.replaceChildren();
  $('#fileCount').textContent = String(roomState.files.length);
  if (!roomState.files.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.append(safeTextElement('span', '', '▤'));
    empty.append(safeTextElement('strong', '', 'No files yet'));
    empty.append(safeTextElement('small', '', 'Upload a video or share a file with your room.'));
    roomFilesList.append(empty);
    return;
  }
  for (const file of roomState.files) {
    const item = document.createElement('div');
    item.className = 'file-item';
    const icon = safeTextElement('span', 'file-type-icon', file.playable ? '▶' : '↓');
    item.append(icon);
    const details = document.createElement('div');
    details.className = 'file-details';
    details.append(safeTextElement('strong', '', file.name));
    details.append(safeTextElement('small', '', `${formatBytes(file.size)} · ${file.playable ? 'Playable media' : 'Shared file'}`));
    item.append(details);
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    if (file.playable) {
      const watchButton = safeTextElement('button', 'file-action', roomState.media?.id === file.id ? 'Selected' : 'Watch');
      watchButton.type = 'button';
      watchButton.disabled = roomState.media?.id === file.id;
      watchButton.addEventListener('click', () => {
        socket.emit('media:select', { fileId: file.id });
        setActiveTab('chat');
      });
      actions.append(watchButton);
    }
    const download = safeTextElement('a', 'file-action download', 'Download');
    download.href = file.url;
    download.download = file.name;
    download.rel = 'noopener';
    actions.append(download);
    item.append(actions);
    roomFilesList.append(item);
  }
}

function renderPeople() {
  const members = roomState.members || [];
  $('#memberCount').textContent = `${members.length} here`;
  roomPeopleList.replaceChildren();
  if (!members.length) {
    roomPeopleList.append(safeTextElement('div', 'list-empty', 'Waiting for your people…'));
    return;
  }
  for (const member of members) {
    const row = document.createElement('div');
    row.className = 'person-row';
    const avatar = safeTextElement('span', 'person-avatar', Array.from(member.name || 'G')[0].toUpperCase());
    row.append(avatar);
    const nameWrap = document.createElement('div');
    nameWrap.className = 'person-name';
    nameWrap.append(safeTextElement('span', '', member.name));
    if (member.id === socket.id) nameWrap.append(safeTextElement('small', 'you-label', 'You'));
    row.append(nameWrap);
    row.append(safeTextElement('span', 'person-live', ''));
    roomPeopleList.append(row);
  }
}

function setActiveTab(tabName) {
  $$('.sidebar-tab').forEach(button => {
    const active = button.dataset.tab === tabName;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $$('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== tabName; });
}

function updateStageEmpty() {
  const hasMedia = Boolean(roomState.media);
  emptyStage.hidden = hasMedia;
  sharedVideo.hidden = !hasMedia;
  if (!hasMedia) {
    nowPlayingName.textContent = 'Nothing queued yet';
    stageStatus.textContent = 'Waiting for the first video';
    syncStatus.textContent = 'Ready when you are';
  }
}

function selectMedia(media, playback) {
  const previousId = roomState.media?.id || null;
  roomState.media = media || null;
  if (playback) roomState.playback = playback;
  renderFiles();
  updateStageEmpty();
  if (!media) {
    sharedVideo.removeAttribute('src');
    sharedVideo.load();
    return;
  }
  nowPlayingName.textContent = media.name;
  stageStatus.textContent = `Shared selection · ${media.name}`;
  syncStatus.textContent = 'Keeping playback aligned';
  if (previousId !== media.id || !sharedVideo.src.endsWith(media.url)) {
    suppressMediaEventsUntil = Date.now() + 700;
    sharedVideo.src = media.url;
    sharedVideo.load();
  }
}

function expectedPlaybackTime(playback) {
  if (!playback) return 0;
  if (playback.paused) return Number(playback.currentTime) || 0;
  const elapsed = Math.max(0, (Date.now() - Number(playback.updatedAt || Date.now())) / 1000);
  return Math.max(0, (Number(playback.currentTime) || 0) + Math.min(elapsed, 10));
}

async function syncVideoToState(force = false) {
  const playback = roomState.playback;
  if (!roomState.media || !playback || sharedVideo.readyState < 1) return;
  const targetTime = expectedPlaybackTime(playback);
  const drift = targetTime - sharedVideo.currentTime;
  if ((force || Math.abs(drift) > 0.8) && !sharedVideo.seeking) {
    try {
      suppressMediaEventsUntil = Date.now() + 450;
      sharedVideo.currentTime = targetTime;
    } catch { /* Some containers may not be seekable yet. */ }
  }
  if (playback.paused) {
    if (!sharedVideo.paused) {
      suppressMediaEventsUntil = Date.now() + 450;
      sharedVideo.pause();
    }
    sharedVideo.playbackRate = 1;
  } else if (sharedVideo.paused) {
    suppressMediaEventsUntil = Date.now() + 700;
    try {
      await sharedVideo.play();
      hideSyncNotice();
    } catch {
      syncStatus.textContent = 'Tap play to enable audio/video';
      showSyncNotice('Your browser blocked synced autoplay. Press play on the video once; room controls will then stay in sync.');
    }
  } else if (!sharedVideo.seeking && Math.abs(drift) > 0.22 && Math.abs(drift) < 0.8) {
    sharedVideo.playbackRate = drift > 0 ? 1.05 : 0.95;
    clearTimeout(rateResetTimeout);
    rateResetTimeout = setTimeout(() => { sharedVideo.playbackRate = 1; }, 850);
  } else if (sharedVideo.playbackRate !== 1 && Math.abs(drift) <= 0.22) {
    sharedVideo.playbackRate = 1;
  }
}

function emitPlaybackUpdate() {
  if (!currentRoomId || !isJoined || !roomState.media || Date.now() < suppressMediaEventsUntil) return;
  socket.emit('playback:update', { currentTime: sharedVideo.currentTime || 0, paused: sharedVideo.paused });
}

function upsertFile(file) {
  const index = roomState.files.findIndex(existing => existing.id === file.id);
  if (index >= 0) roomState.files[index] = file;
  else roomState.files.push(file);
  renderFiles();
}

async function copyInviteLink() {
  const link = `${location.origin}/room/${encodeURIComponent(currentRoomId)}`;
  try {
    await navigator.clipboard.writeText(link);
    showToast('Invite link copied — send it to your people.');
  } catch {
    window.prompt('Copy this invite link:', link);
  }
}

function uploadSelectedFile(file) {
  if (!file || !currentRoomId || isUploading) return;
  isUploading = true;
  uploadProgressText.hidden = false;
  uploadProgressText.textContent = 'Uploading… 0%';
  $('#uploadFileBtn').disabled = true;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/rooms/${encodeURIComponent(currentRoomId)}/files`);
  xhr.upload.addEventListener('progress', event => {
    if (event.lengthComputable) uploadProgressText.textContent = `Uploading… ${Math.round(event.loaded / event.total * 100)}%`;
  });
  xhr.addEventListener('load', () => {
    isUploading = false;
    $('#uploadFileBtn').disabled = false;
    uploadProgressText.hidden = true;
    if (xhr.status >= 200 && xhr.status < 300) {
      const result = JSON.parse(xhr.responseText || '{}');
      if (result.file) upsertFile(result.file);
      if (result.media) {
        roomState.playback = result.playback || roomState.playback;
        selectMedia(result.media, result.playback);
      }
      setActiveTab(result.file?.playable ? 'chat' : 'files');
      showToast(result.file?.playable ? 'Video shared with the whole room.' : 'File shared with everyone in the room.');
    } else {
      let message = 'Upload failed. Please try again.';
      try { message = JSON.parse(xhr.responseText).error || message; } catch { /* ignore */ }
      showToast(message);
    }
    fileInput.value = '';
  });
  xhr.addEventListener('error', () => {
    isUploading = false;
    $('#uploadFileBtn').disabled = false;
    uploadProgressText.hidden = true;
    fileInput.value = '';
    showToast('Upload interrupted. Check your connection and try again.');
  });
  const formData = new FormData();
  formData.append('file', file);
  xhr.send(formData);
}

createRoomBtn.addEventListener('click', () => {
  userName();
  createRoomBtn.disabled = true;
  createRoomBtn.querySelector('span').textContent = 'Creating your room…';
  socket.emit('room:create', response => {
    createRoomBtn.disabled = false;
    createRoomBtn.querySelector('span').textContent = 'Create a room';
    if (!response?.ok || !response.roomId) return showToast('Could not create a room. Please try again.');
    navigateToRoom(response.roomId);
  });
});

joinRoomForm.addEventListener('submit', event => {
  event.preventDefault();
  userName();
  const roomId = roomIdFromInput(roomCodeInput.value);
  if (!roomId) return showToast('Enter a room code or paste a valid room link.');
  navigateToRoom(roomId);
});

copyLinkBtn.addEventListener('click', copyInviteLink);
$('#emptyUploadBtn').addEventListener('click', () => fileInput.click());
$('#uploadFileBtn').addEventListener('click', () => fileInput.click());
$('#filesUploadBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => uploadSelectedFile(fileInput.files?.[0]));
$('#dismissSyncNotice').addEventListener('click', hideSyncNotice);

$$('.sidebar-tab').forEach(button => button.addEventListener('click', () => setActiveTab(button.dataset.tab)));

chatForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !currentRoomId) return;
  socket.emit('chat:send', { text });
  chatInput.value = '';
  chatInput.focus();
});

sharedVideo.addEventListener('play', emitPlaybackUpdate);
sharedVideo.addEventListener('pause', emitPlaybackUpdate);
sharedVideo.addEventListener('seeked', emitPlaybackUpdate);
sharedVideo.addEventListener('loadedmetadata', () => syncVideoToState(true));
sharedVideo.addEventListener('playing', () => {
  syncStatus.textContent = 'Playback aligned';
  hideSyncNotice();
});
sharedVideo.addEventListener('waiting', () => { syncStatus.textContent = 'Buffering on this connection…'; });
sharedVideo.addEventListener('error', () => {
  if (roomState.media) showToast('This video format may not play in your browser. Try an MP4 (H.264/AAC) or WebM file.');
});

// Allow dropping a file directly onto the theatre.
const cinemaFrame = $('.cinema-frame');
cinemaFrame.addEventListener('dragover', event => { event.preventDefault(); cinemaFrame.classList.add('is-dragging'); });
cinemaFrame.addEventListener('dragleave', event => {
  if (!cinemaFrame.contains(event.relatedTarget)) cinemaFrame.classList.remove('is-dragging');
});
cinemaFrame.addEventListener('drop', event => {
  event.preventDefault();
  cinemaFrame.classList.remove('is-dragging');
  const file = event.dataTransfer?.files?.[0];
  if (file) uploadSelectedFile(file);
});

socket.on('connect', () => {
  if (currentRoomId && !isJoined) requestRoomJoin(currentRoomId);
});
socket.on('disconnect', () => {
  isJoined = false;
  joinInFlightFor = null;
  syncStatus.textContent = 'Reconnecting…';
});
socket.on('connect_error', () => { syncStatus.textContent = 'Connection problem — retrying'; });

socket.on('room:state', state => {
  currentRoomId = state.roomId;
  isJoined = true;
  joinInFlightFor = null;
  roomCodeLabel.textContent = state.roomId;
  roomState.members = state.members || [];
  roomState.files = state.files || [];
  roomState.messages = state.messages || [];
  roomState.playback = state.playback || { paused: true, currentTime: 0, updatedAt: Date.now() };
  roomState.media = null;
  renderPeople();
  renderFiles();
  renderChat();
  selectMedia(state.media || null, state.playback || roomState.playback);
  if (state.media) syncStatus.textContent = 'Syncing with the room…';
});

socket.on('room:members', members => {
  roomState.members = members || [];
  renderPeople();
});
socket.on('file:added', file => upsertFile(file));
socket.on('media:changed', payload => {
  roomState.playback = payload.playback || roomState.playback;
  selectMedia(payload.media || null, payload.playback);
  syncVideoToState(true);
  showToast(`Now queued: ${payload.media?.name || 'media'}`);
});
socket.on('playback:state', playback => {
  roomState.playback = playback;
  if (playback.actor === socket.id) return;
  syncVideoToState(false);
});
socket.on('chat:new', message => {
  roomState.messages.push(message);
  if (roomState.messages.length > 100) roomState.messages.shift();
  if (chatMessages.querySelector('.welcome-message')) chatMessages.replaceChildren();
  appendChatMessage(message);
  $('#chatCount').textContent = String(roomState.messages.length);
});

setInterval(() => {
  if (currentRoomId && isJoined && roomState.media && roomState.playback) syncVideoToState(false);
}, 1800);

$('#backHome').addEventListener('click', event => { event.preventDefault(); resetHomeUrl(); });
$('#leaveRoomLink').addEventListener('click', event => { event.preventDefault(); resetHomeUrl(); });
$('#brandHome').addEventListener('click', event => {
  if (!homeView.hidden) return;
  event.preventDefault();
  resetHomeUrl();
});
window.addEventListener('popstate', () => {
  const match = location.pathname.match(/^\/room\/([A-Za-z0-9_-]{4,32})\/?$/);
  if (match) enterRoom(match[1].toUpperCase());
  else resetHomeUrl(false);
});

const savedName = localStorage.getItem('watchparty-name');
if (savedName) displayNameInput.value = savedName;
const initialRoomMatch = location.pathname.match(/^\/room\/([A-Za-z0-9_-]{4,32})\/?$/);
if (initialRoomMatch) enterRoom(initialRoomMatch[1].toUpperCase());
else setView(false);
