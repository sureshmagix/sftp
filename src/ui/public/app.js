// Global Application State
let currentLocalPath = '';
let currentRemotePath = '.';
let localFilesCache = [];
let remoteFilesCache = [];
let isConnected = false;
let ws = null;
let currentServerPort = 3000;
let primaryServerIp = '127.0.0.1';
let commandHistory = [];
let historyIndex = -1;

// Default Sort: Last Modified Date descending (newest on top)
let sortState = {
  local: { key: 'modifyTime', asc: false },
  remote: { key: 'modifyTime', asc: false }
};

// Auto-Refresh & Transfers State
let autoRefreshInterval = 5000;
let autoRefreshTimer = null;
let activeTransfersCache = [];
let recentlyTransferredPaths = new Set();
let isLocalRecentFilterActive = false;
let isRemoteRecentFilterActive = false;

// Themes & Font State
let currentTheme = localStorage.getItem('sftp_theme') || 'theme-midnight';
let currentUiFontSize = localStorage.getItem('sftp_ui_font_size') || 'font-size-md';
let currentTermFontSize = parseInt(localStorage.getItem('sftp_term_font_size') || '12', 10);

// Cross-Platform Path Helpers (Windows & POSIX)
function normalizePath(p) {
  if (!p) return '';
  let norm = p.toString().replace(/\\/g, '/').replace(/\/+/g, '/');
  // Normalize Windows drive letter e.g. "C:" -> "C:/"
  if (/^[a-zA-Z]:$/.test(norm)) {
    norm += '/';
  }
  // Remove trailing slash unless it's root ("/" or "C:/")
  if (norm.length > 1 && norm.endsWith('/') && !/^[a-zA-Z]:\/$/.test(norm)) {
    norm = norm.slice(0, -1);
  }
  return norm;
}

function joinPath(base, child) {
  const normBase = normalizePath(base);
  if (!normBase || normBase === '.') return child;
  if (normBase.endsWith('/')) return `${normBase}${child}`;
  return `${normBase}/${child}`;
}

function getParentPath(p, isLocal = false) {
  const norm = normalizePath(p);
  if (!norm || norm === '/' || norm === '.') return isLocal ? '/' : '/';
  
  // Windows drive root check e.g. "C:/" or "C:"
  if (/^[a-zA-Z]:\/?$/.test(norm)) {
    return norm.endsWith('/') ? norm : norm + '/';
  }

  const lastSlash = norm.lastIndexOf('/');
  if (lastSlash === -1) return isLocal ? '/' : '/';
  
  // If parent is drive root e.g. "C:/Users" -> lastSlash at 2 -> "C:/"
  if (lastSlash === 2 && /^[a-zA-Z]:/.test(norm)) {
    return norm.substring(0, 3);
  }
  
  if (lastSlash === 0) return '/';
  return norm.substring(0, lastSlash);
}

function getPathBaseName(p) {
  const norm = normalizePath(p);
  if (!norm) return '';
  if (/^[a-zA-Z]:\/?$/.test(norm)) return norm;
  const parts = norm.split('/').filter(Boolean);
  return parts.pop() || norm;
}

// Detachable Terminal State
let isTerminalDetached = false;
let isTerminalMaximized = false;
let isTerminalMinimized = false;

// File Viewer Active State
let activeViewerFile = null;

// Multi-Client Profiles State (Generic Server Defaults)
const DEFAULT_PROFILES = [
  {
    id: 'client-remote',
    name: '🌐 Remote Linux / Unix Server',
    host: '192.168.1.100',
    port: 22,
    username: 'ubuntu',
    password: '',
    keyPath: '',
    rememberPassword: true,
  },
  {
    id: 'client-local',
    name: '🖥️ Localhost (127.0.0.1)',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    password: '',
    keyPath: '',
    rememberPassword: true,
  },
];

let savedClients = [];
let activeClientId = 'client-remote';

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  initThemesAndFonts();
  initServerInfo();
  initWebSocket();
  initAutoRefresh();
  initClientProfiles();
  updateSortHeaderIndicators('local');
  updateSortHeaderIndicators('remote');
  fetchInitialLocalDir();
  checkConnectionStatus();
  setInterval(fetchTransfers, 1000);
  setupTerminalHistory();
  initDragAndDrop();
  initFloatingWindowDrag();
});

// -------------------------------------------------------------
// 1. Theme & Font Size Preferences Engine
// -------------------------------------------------------------
const ALL_THEMES = [
  'theme-midnight',
  'theme-github-dark',
  'theme-vscode-dark',
  'theme-onedark',
  'theme-catppuccin',
  'theme-dracula',
  'theme-nord',
  'theme-matrix',
  'theme-solarized',
  'theme-light',
  'theme-github-light',
  'theme-nord-light',
  'theme-solarized-light'
];

const UI_FONT_SCALES = [
  { id: 'font-size-xs', label: '80%', px: 10.5 },
  { id: 'font-size-sm', label: '90%', px: 11.5 },
  { id: 'font-size-md', label: '100%', px: 13.0 },
  { id: 'font-size-lg', label: '115%', px: 14.5 },
  { id: 'font-size-xl', label: '130%', px: 16.0 },
  { id: 'font-size-2xl', label: '150%', px: 18.0 }
];

let currentFontScaleIndex = 2; // font-size-md (100%)

function initThemesAndFonts() {
  setTheme(currentTheme, false);
  setUiFontSize(currentUiFontSize, false);
  setTermFontSize(currentTermFontSize, false);
  initZoomKeybindings();
}

function initZoomKeybindings() {
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      increaseGlobalFontSize();
    } else if ((e.metaKey || e.ctrlKey) && (e.key === '-' || e.key === '_')) {
      e.preventDefault();
      decreaseGlobalFontSize();
    } else if ((e.metaKey || e.ctrlKey) && e.key === '0') {
      e.preventDefault();
      resetGlobalFontSize();
    }
  });
}

function setTheme(themeName, showNotification = true) {
  currentTheme = themeName;
  document.body.classList.remove(...ALL_THEMES);
  document.body.classList.add(themeName);
  localStorage.setItem('sftp_theme', themeName);

  document.querySelectorAll('.theme-card').forEach(card => {
    card.classList.toggle('active', card.getAttribute('data-theme') === themeName);
  });

  if (showNotification) {
    const cleanName = themeName.replace('theme-', '').replace('-', ' ').toUpperCase();
    showToast('info', `Theme: ${cleanName}`);
  }
}

function setUiFontSize(sizeClass, showNotification = true) {
  currentUiFontSize = sizeClass;
  const idx = UI_FONT_SCALES.findIndex(s => s.id === sizeClass);
  if (idx !== -1) currentFontScaleIndex = idx;

  document.body.classList.remove('font-size-xs', 'font-size-sm', 'font-size-md', 'font-size-lg', 'font-size-xl', 'font-size-2xl');
  document.body.classList.add(sizeClass);
  localStorage.setItem('sftp_ui_font_size', sizeClass);

  const scale = UI_FONT_SCALES[currentFontScaleIndex] || UI_FONT_SCALES[2];
  const badge = document.getElementById('zoomLevelBadge');
  if (badge) badge.innerText = scale.label;

  document.querySelectorAll('.font-chip').forEach(chip => {
    chip.classList.toggle('active', chip.getAttribute('data-size') === sizeClass);
  });

  if (showNotification) {
    showToast('info', `UI Font Scale: ${scale.label} (${scale.px}px)`);
  }
}

function increaseGlobalFontSize() {
  if (currentFontScaleIndex < UI_FONT_SCALES.length - 1) {
    currentFontScaleIndex++;
    setUiFontSize(UI_FONT_SCALES[currentFontScaleIndex].id, true);
  } else {
    showToast('info', 'Maximum zoom level reached');
  }
}

function decreaseGlobalFontSize() {
  if (currentFontScaleIndex > 0) {
    currentFontScaleIndex--;
    setUiFontSize(UI_FONT_SCALES[currentFontScaleIndex].id, true);
  } else {
    showToast('info', 'Minimum zoom level reached');
  }
}

function resetGlobalFontSize() {
  currentFontScaleIndex = 2; // font-size-md (100%)
  setUiFontSize('font-size-md', true);
}

function setTermFontSize(size, showNotification = true) {
  currentTermFontSize = Math.max(9, Math.min(24, parseInt(size, 10) || 12));
  localStorage.setItem('sftp_term_font_size', currentTermFontSize);

  const termOutput = document.getElementById('terminalOutput');
  const termInput = document.getElementById('termInput');
  if (termOutput) termOutput.style.fontSize = `${currentTermFontSize}px`;
  if (termInput) termInput.style.fontSize = `${currentTermFontSize}px`;

  const termFontDisplay = document.getElementById('termFontDisplay');
  const floatingFontDisplay = document.getElementById('floatingFontDisplay');
  if (termFontDisplay) termFontDisplay.innerText = `${currentTermFontSize}px`;
  if (floatingFontDisplay) floatingFontDisplay.innerText = `${currentTermFontSize}px`;

  document.querySelectorAll('.term-chip').forEach(chip => {
    chip.classList.toggle('active', parseInt(chip.getAttribute('data-tsize'), 10) === currentTermFontSize);
  });

  if (showNotification) {
    showToast('info', `Terminal font: ${currentTermFontSize}px`);
  }
}

function adjustTermFontSize(delta) {
  setTermFontSize(currentTermFontSize + delta, true);
}

function openPreferencesModal() {
  document.getElementById('preferencesModal').classList.add('open');
}

function closePreferencesModal() {
  document.getElementById('preferencesModal').classList.remove('open');
}

// -------------------------------------------------------------
// 2. Multi-Client Profiles & Password Remember Engine
// -------------------------------------------------------------
function initClientProfiles() {
  const stored = localStorage.getItem('sftp_client_profiles');
  if (stored) {
    try {
      savedClients = JSON.parse(stored);
    } catch (e) {
      savedClients = [...DEFAULT_PROFILES];
    }
  } else {
    savedClients = [...DEFAULT_PROFILES];
    saveClientsToStorage();
  }

  const storedActive = localStorage.getItem('sftp_active_client_id');
  if (storedActive && savedClients.some(c => c.id === storedActive)) {
    activeClientId = storedActive;
  } else if (savedClients.length > 0) {
    activeClientId = savedClients[0].id;
  }

  populateClientDropdown();
  applyClientToForm(activeClientId);
}

function saveClientsToStorage() {
  localStorage.setItem('sftp_client_profiles', JSON.stringify(savedClients));
}

function populateClientDropdown() {
  const select = document.getElementById('profileSelect');
  if (!select) return;

  select.innerHTML = savedClients.map(c => `
    <option value="${c.id}" ${c.id === activeClientId ? 'selected' : ''}>
      ${escapeHtml(c.name)} (${c.username}@${c.host}:${c.port})
    </option>
  `).join('');
}

function handleClientProfileChange() {
  const select = document.getElementById('profileSelect');
  activeClientId = select.value;
  localStorage.setItem('sftp_active_client_id', activeClientId);
  applyClientToForm(activeClientId);
  showToast('info', `Switched to profile: ${getCurrentClientName()}`);
}

function getCurrentClientName() {
  const client = savedClients.find(c => c.id === activeClientId);
  return client ? client.name : 'Custom';
}

function applyClientToForm(clientId) {
  const client = savedClients.find(c => c.id === clientId);
  if (!client) return;

  document.getElementById('sshHost').value = client.host || '';
  document.getElementById('sshPort').value = client.port || 22;
  document.getElementById('sshUser').value = client.username || '';
  document.getElementById('sshKeyPath').value = client.keyPath || '';

  const rememberCheck = document.getElementById('rememberPasswordCheck');
  if (rememberCheck) {
    rememberCheck.checked = client.rememberPassword !== false;
  }

  const passInput = document.getElementById('sshPassword');
  if (client.rememberPassword !== false && client.password) {
    passInput.value = client.password;
  } else {
    passInput.value = '';
  }

  // Clear any existing error highlights
  passInput.classList.remove('input-error');
  document.getElementById('sshUser').classList.remove('input-error');
}

function saveCurrentProfilePrompt() {
  const currentClient = savedClients.find(c => c.id === activeClientId);
  const host = document.getElementById('sshHost').value.trim();
  const port = parseInt(document.getElementById('sshPort').value, 10) || 22;
  const username = document.getElementById('sshUser').value.trim();
  const password = document.getElementById('sshPassword').value;
  const keyPath = document.getElementById('sshKeyPath').value.trim();
  const remember = document.getElementById('rememberPasswordCheck').checked;

  if (!currentClient) {
    showToast('error', 'No active profile selected');
    return;
  }

  currentClient.host = host;
  currentClient.port = port;
  currentClient.username = username;
  currentClient.keyPath = keyPath;
  currentClient.rememberPassword = remember;
  currentClient.password = remember ? password : '';

  saveClientsToStorage();
  populateClientDropdown();
  showToast('success', `Saved settings for "${currentClient.name}"!`);
}

function openClientsModal() {
  document.getElementById('clientsModal').classList.add('open');
  hideClientForm();
  renderClientsList();
}

function closeClientsModal() {
  document.getElementById('clientsModal').classList.remove('open');
}

function renderClientsList() {
  const container = document.getElementById('clientsListGrid');
  if (!container) return;

  if (savedClients.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No saved clients. Click <strong>Add Client</strong> to add one.</p></div>`;
    return;
  }

  container.innerHTML = savedClients.map(client => {
    const isActive = client.id === activeClientId;
    const hasPass = Boolean(client.password);

    return `
      <div class="client-card ${isActive ? 'active-client' : ''}">
        <div class="client-card-header">
          <div class="client-card-title">
            <i class="fa-solid fa-server text-accent"></i>
            <span>${escapeHtml(client.name)}</span>
          </div>
          ${isActive ? '<span class="client-active-pill"><i class="fa-solid fa-circle-check"></i> Active</span>' : ''}
        </div>
        <div class="client-card-details">
          <div><i class="fa-solid fa-network-wired"></i> Host: <code>${escapeHtml(client.host)}:${client.port}</code></div>
          <div><i class="fa-solid fa-user"></i> User: <strong>${escapeHtml(client.username)}</strong></div>
          <div>
            <i class="fa-solid fa-lock"></i> Password: 
            ${hasPass ? '<span style="color: var(--accent-emerald);">Saved (Remembered)</span>' : '<span style="color: var(--text-dim);">Prompt on connect</span>'}
          </div>
          ${client.keyPath ? `<div><i class="fa-solid fa-key"></i> Key: <code>${escapeHtml(client.keyPath)}</code></div>` : ''}
        </div>
        <div class="client-card-footer">
          <button class="btn btn-connect btn-sm" onclick="connectToClient('${client.id}')">
            <i class="fa-solid fa-link"></i> Connect
          </button>
          <div class="client-card-actions">
            <button class="btn-mini" onclick="editClientProfile('${client.id}')" title="Edit Profile"><i class="fa-solid fa-pen"></i></button>
            <button class="btn-mini" onclick="duplicateClientProfile('${client.id}')" title="Duplicate Profile"><i class="fa-regular fa-copy"></i></button>
            ${savedClients.length > 1 ? `
              <button class="btn-mini btn-file-del" onclick="deleteClientProfile('${client.id}')" title="Delete Profile"><i class="fa-solid fa-trash"></i></button>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function showNewClientForm() {
  document.getElementById('clientFormTitle').innerHTML = '<i class="fa-solid fa-plus text-accent"></i> Add New Client Profile';
  document.getElementById('editClientId').value = '';
  document.getElementById('editClientName').value = 'Production Server';
  document.getElementById('editClientHost').value = '';
  document.getElementById('editClientPort').value = 22;
  document.getElementById('editClientUser').value = 'ubuntu';
  document.getElementById('editClientPassword').value = '';
  document.getElementById('editClientKeyPath').value = '';
  document.getElementById('clientEditForm').style.display = 'block';
  document.getElementById('clientEditForm').scrollIntoView({ behavior: 'smooth' });
}

function hideClientForm() {
  document.getElementById('clientEditForm').style.display = 'none';
}

function editClientProfile(id) {
  const client = savedClients.find(c => c.id === id);
  if (!client) return;

  document.getElementById('clientFormTitle').innerHTML = `<i class="fa-solid fa-pen-to-square text-accent"></i> Edit "${escapeHtml(client.name)}"`;
  document.getElementById('editClientId').value = client.id;
  document.getElementById('editClientName').value = client.name;
  document.getElementById('editClientHost').value = client.host;
  document.getElementById('editClientPort').value = client.port || 22;
  document.getElementById('editClientUser').value = client.username;
  document.getElementById('editClientPassword').value = client.password || '';
  document.getElementById('editClientKeyPath').value = client.keyPath || '';
  document.getElementById('clientEditForm').style.display = 'block';
  document.getElementById('clientEditForm').scrollIntoView({ behavior: 'smooth' });
}

function saveClientFromForm() {
  const id = document.getElementById('editClientId').value;
  const name = document.getElementById('editClientName').value.trim() || 'Remote Server';
  const host = document.getElementById('editClientHost').value.trim();
  const port = parseInt(document.getElementById('editClientPort').value, 10) || 22;
  const username = document.getElementById('editClientUser').value.trim() || 'ubuntu';
  const password = document.getElementById('editClientPassword').value;
  const keyPath = document.getElementById('editClientKeyPath').value.trim();

  if (!host) {
    showToast('error', 'Please enter Remote Host / IP');
    return;
  }

  if (id) {
    const existing = savedClients.find(c => c.id === id);
    if (existing) {
      existing.name = name;
      existing.host = host;
      existing.port = port;
      existing.username = username;
      existing.password = password;
      existing.keyPath = keyPath;
      existing.rememberPassword = Boolean(password);
    }
  } else {
    const newId = 'client-' + Date.now();
    savedClients.push({
      id: newId,
      name,
      host,
      port,
      username,
      password,
      keyPath,
      rememberPassword: Boolean(password),
    });
    activeClientId = newId;
  }

  saveClientsToStorage();
  populateClientDropdown();
  applyClientToForm(activeClientId);
  hideClientForm();
  renderClientsList();
  showToast('success', `Saved client profile: ${name}`);
}

function duplicateClientProfile(id) {
  const source = savedClients.find(c => c.id === id);
  if (!source) return;

  const newId = 'client-' + Date.now();
  const newClient = {
    ...source,
    id: newId,
    name: `${source.name} (Copy)`,
  };

  savedClients.push(newClient);
  saveClientsToStorage();
  populateClientDropdown();
  renderClientsList();
  showToast('info', `Duplicated "${source.name}"`);
}

function deleteClientProfile(id) {
  if (savedClients.length <= 1) {
    showToast('error', 'You must have at least one client profile.');
    return;
  }
  const client = savedClients.find(c => c.id === id);
  if (!confirm(`Are you sure you want to delete profile "${client?.name || id}"?`)) return;

  savedClients = savedClients.filter(c => c.id !== id);
  if (activeClientId === id) {
    activeClientId = savedClients[0].id;
    applyClientToForm(activeClientId);
  }

  saveClientsToStorage();
  populateClientDropdown();
  renderClientsList();
  showToast('info', 'Client profile deleted.');
}

function connectToClient(id) {
  activeClientId = id;
  localStorage.setItem('sftp_active_client_id', activeClientId);
  populateClientDropdown();
  applyClientToForm(activeClientId);
  closeClientsModal();
  document.getElementById('connectionForm').dispatchEvent(new Event('submit'));
}

function exportClientProfiles() {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(savedClients, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute('href', dataStr);
  downloadAnchor.setAttribute('download', `sb_sftp_clients_backup_${Date.now()}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  showToast('success', 'Exported client profiles JSON backup');
}

function triggerImportProfiles() {
  document.getElementById('importProfilesInput').click();
}

function handleImportProfilesFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (Array.isArray(imported) && imported.length > 0) {
        savedClients = imported;
        activeClientId = savedClients[0].id;
        saveClientsToStorage();
        populateClientDropdown();
        applyClientToForm(activeClientId);
        renderClientsList();
        showToast('success', `Successfully imported ${imported.length} client profiles!`);
      } else {
        showToast('error', 'Invalid JSON profile structure');
      }
    } catch (err) {
      showToast('error', 'Failed to parse JSON file');
    }
  };
  reader.readAsText(file);
}

// -------------------------------------------------------------
// 3. Server Network & Port Management
// -------------------------------------------------------------
async function initServerInfo() {
  try {
    const res = await fetch('/api/server-info');
    const data = await res.json();
    currentServerPort = data.currentPort || window.location.port || 3000;
    primaryServerIp = data.primaryIp || '127.0.0.1';

    // Update Header Display
    document.getElementById('displayServerIp').innerText = primaryServerIp;
    document.getElementById('displayServerPort').innerText = currentServerPort;
    document.getElementById('newPortInput').value = currentServerPort;

    // Populate Modal IP List
    renderIpAddressList(data.ipAddresses, currentServerPort);
  } catch (err) {
    console.error('Failed to load server info:', err);
  }
}

function renderIpAddressList(ipList, port) {
  const container = document.getElementById('ipAddressList');
  if (!ipList || ipList.length === 0) {
    container.innerHTML = `<div class="ip-item"><code class="ip-code">http://127.0.0.1:${port}</code></div>`;
    return;
  }

  container.innerHTML = ipList.map(item => {
    const fullUrl = `http://${item.address}:${port}`;
    return `
      <div class="ip-item">
        <span class="ip-name">${item.name} (${item.internal ? 'Local' : 'LAN'})</span>
        <code class="ip-code">${fullUrl}</code>
        <button class="btn-copy" onclick="copyText('${fullUrl}')" title="Copy URL"><i class="fa-regular fa-copy"></i></button>
      </div>
    `;
  }).join('');
}

function openPortModal() {
  document.getElementById('portModal').classList.add('open');
  initServerInfo();
}

function closePortModal() {
  document.getElementById('portModal').classList.remove('open');
}

function setPortField(port) {
  document.getElementById('newPortInput').value = port;
}

async function submitPortChange() {
  const newPort = parseInt(document.getElementById('newPortInput').value, 10);
  if (isNaN(newPort) || newPort < 1024 || newPort > 65535) {
    showToast('error', 'Please enter a valid port between 1024 and 65535');
    return;
  }

  if (newPort === currentServerPort) {
    showToast('info', `Server is already running on port ${newPort}`);
    closePortModal();
    return;
  }

  const btnSubmit = document.getElementById('btnSubmitPort');
  btnSubmit.disabled = true;
  btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Switching Port...';

  try {
    const res = await fetch('/api/server-port', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPort }),
    });

    const data = await res.json();
    if (data.success) {
      showToast('success', `Port changed to ${newPort}! Redirecting in 2 seconds...`);
      setTimeout(() => {
        const protocol = window.location.protocol;
        const hostname = window.location.hostname;
        window.location.href = `${protocol}//${hostname}:${newPort}`;
      }, 1800);
    } else {
      showToast('error', `Failed to switch port: ${data.error}`);
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Update & Switch Port';
    }
  } catch (err) {
    showToast('success', `Port changed to ${newPort}! Redirecting...`);
    setTimeout(() => {
      const protocol = window.location.protocol;
      const hostname = window.location.hostname;
      window.location.href = `${protocol}//${hostname}:${newPort}`;
    }, 1800);
  }
}

function copyServerUrl() {
  const url = `http://${primaryServerIp}:${currentServerPort}`;
  copyText(url);
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('info', `Copied: ${text}`);
  }).catch(() => {
    showToast('info', `URL: ${text}`);
  });
}

// -------------------------------------------------------------
// 4. Auto-Refresh Engine & Recent Filter
// -------------------------------------------------------------
function initAutoRefresh() {
  const savedInterval = localStorage.getItem('sftp_auto_refresh_interval');
  if (savedInterval !== null) {
    autoRefreshInterval = parseInt(savedInterval, 10);
    const select = document.getElementById('autoRefreshSelect');
    if (select) select.value = autoRefreshInterval;
  }
  startAutoRefreshTimer();
}

function handleAutoRefreshChange(val) {
  autoRefreshInterval = parseInt(val, 10);
  localStorage.setItem('sftp_auto_refresh_interval', autoRefreshInterval);
  startAutoRefreshTimer();
  if (autoRefreshInterval > 0) {
    showToast('info', `Auto-sync set to ${autoRefreshInterval / 1000}s`);
    triggerManualSync();
  } else {
    showToast('info', 'Auto-sync turned off');
  }
}

function startAutoRefreshTimer() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  if (autoRefreshInterval > 0) {
    autoRefreshTimer = setInterval(() => {
      silentSyncAll();
    }, autoRefreshInterval);
  }
}

function triggerManualSync() {
  const badge = document.getElementById('autoRefreshBadge');
  if (badge) {
    badge.classList.add('syncing');
    setTimeout(() => badge.classList.remove('syncing'), 800);
  }
  silentSyncAll();
  showToast('info', 'Syncing directories...');
}

async function silentSyncAll() {
  if (currentLocalPath) {
    try {
      const res = await fetch(`/api/list-local?path=${encodeURIComponent(currentLocalPath)}`);
      const data = await res.json();
      const files = data.files || (Array.isArray(data) ? data : []);
      if (Array.isArray(files)) {
        localFilesCache = files;
        applyLocalFileFilter();
      }
    } catch (_) {}
  }

  if (isConnected && currentRemotePath) {
    try {
      const res = await fetch(`/api/list-remote?path=${encodeURIComponent(currentRemotePath)}`);
      const data = await res.json();
      const files = data.files || (Array.isArray(data) ? data : []);
      if (Array.isArray(files)) {
        remoteFilesCache = files;
        applyRemoteFileFilter();
      }
    } catch (_) {}
  }
}

function toggleRecentFilter(type) {
  if (type === 'local') {
    isLocalRecentFilterActive = !isLocalRecentFilterActive;
    const btn = document.getElementById('btnLocalRecent');
    if (btn) btn.classList.toggle('active', isLocalRecentFilterActive);
    applyLocalFileFilter();
    showToast('info', isLocalRecentFilterActive ? 'Showing recently uploaded/modified local files' : 'Showing all local files');
  } else {
    isRemoteRecentFilterActive = !isRemoteRecentFilterActive;
    const btn = document.getElementById('btnRemoteRecent');
    if (btn) btn.classList.toggle('active', isRemoteRecentFilterActive);
    applyRemoteFileFilter();
    showToast('info', isRemoteRecentFilterActive ? 'Showing recently uploaded/modified remote files' : 'Showing all remote files');
  }
}

function isItemRecent(file, fullPath) {
  if (recentlyTransferredPaths.has(fullPath) || recentlyTransferredPaths.has(file.name)) {
    return true;
  }
  if (file.modifyTime) {
    const mtime = new Date(file.modifyTime).getTime();
    const now = Date.now();
    // Modified in last 24 hours
    if (now - mtime < 24 * 60 * 60 * 1000) {
      return true;
    }
  }
  return false;
}

function applySortToFiles(files, sortConfig) {
  if (!files || files.length === 0) return [];
  const { key, asc } = sortConfig;
  const sorted = [...files];

  sorted.sort((a, b) => {
    // Directories always first
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;

    let valA = a[key];
    let valB = b[key];

    if (key === 'modifyTime') {
      valA = valA ? new Date(valA).getTime() : 0;
      valB = valB ? new Date(valB).getTime() : 0;
      return asc ? valA - valB : valB - valA;
    }

    if (key === 'size') {
      valA = valA || 0;
      valB = valB || 0;
      return asc ? valA - valB : valB - valA;
    }

    if (key === 'name') {
      valA = (valA || '').toString().toLowerCase();
      valB = (valB || '').toString().toLowerCase();
      return asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }

    return 0;
  });

  return sorted;
}

function handleSortClick(panelType, key) {
  const current = sortState[panelType];
  if (current.key === key) {
    current.asc = !current.asc;
  } else {
    current.key = key;
    current.asc = key === 'name';
  }

  updateSortHeadersUI(panelType);

  if (panelType === 'local') {
    applyLocalFileFilter();
  } else {
    applyRemoteFileFilter();
  }
}

function updateSortHeadersUI(panelType) {
  const prefix = panelType === 'local' ? 'sortLocal' : 'sortRemote';
  const current = sortState[panelType];
  const keys = ['Name', 'Size', 'Date'];

  keys.forEach(k => {
    const headerEl = document.getElementById(`${prefix}${k}`);
    if (!headerEl) return;
    const iconEl = headerEl.querySelector('.sort-icon');
    const lowerKey = k === 'Date' ? 'modifyTime' : k.toLowerCase();

    if (current.key === lowerKey) {
      headerEl.classList.add('sort-active');
      if (iconEl) {
        iconEl.className = current.asc
          ? 'fa-solid fa-arrow-up-short-wide sort-icon'
          : 'fa-solid fa-arrow-down-wide-short sort-icon';
      }
    } else {
      headerEl.classList.remove('sort-active');
      if (iconEl) {
        iconEl.className = 'fa-solid fa-sort sort-icon';
      }
    }
  });
}

function applyLocalFileFilter() {
  const searchInput = document.getElementById('localSearchInput');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  let filtered = [...localFilesCache];

  if (query) {
    filtered = filtered.filter(f => f.name.toLowerCase().includes(query));
  }

  if (isLocalRecentFilterActive) {
    filtered = filtered.filter(f => {
      const fullPath = joinPath(currentLocalPath, f.name);
      return isItemRecent(f, fullPath);
    });
  }

  filtered = applySortToFiles(filtered, sortState.local);
  renderLocalFiles(filtered);
}

function applyRemoteFileFilter() {
  const searchInput = document.getElementById('remoteSearchInput');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  let filtered = [...remoteFilesCache];

  if (query) {
    filtered = filtered.filter(f => f.name.toLowerCase().includes(query));
  }

  if (isRemoteRecentFilterActive) {
    filtered = filtered.filter(f => {
      const fullPath = joinPath(currentRemotePath, f.name);
      return isItemRecent(f, fullPath);
    });
  }

  filtered = applySortToFiles(filtered, sortState.remote);
  renderRemoteFiles(filtered);
}

// -------------------------------------------------------------
// 5. WebSocket & Connection Status
// -------------------------------------------------------------
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'transfer-progress') {
        renderTransfersList(data.transfers);
      } else if (data.type === 'task-completed') {
        const task = data.task;
        if (task) {
          showToast('success', `Completed: ${task.fileName} (${task.transferredFormatted || formatBytes(task.totalBytes)})`);
          if (task.localPath) recentlyTransferredPaths.add(task.localPath);
          if (task.remotePath) recentlyTransferredPaths.add(task.remotePath);
          if (task.fileName) recentlyTransferredPaths.add(task.fileName);
        }
        silentSyncAll();
      } else if (data.type === 'task-failed') {
        const task = data.task;
        if (task) {
          showToast('error', `Failed: ${task.fileName} - ${task.error || 'Unknown error'}`);
        }
      } else if (data.type === 'queue-empty') {
        silentSyncAll();
      }
    } catch (e) {
      console.error('Error parsing WS message:', e);
    }
  };

  ws.onclose = () => {
    setTimeout(initWebSocket, 3000);
  };
}

async function checkConnectionStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    updateConnectionUI(data.status);
  } catch (e) {
    updateConnectionUI('disconnected');
  }
}

function updateConnectionUI(status) {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const btnConnect = document.getElementById('btnConnect');
  const btnDisconnect = document.getElementById('btnDisconnect');
  const remoteSearchInput = document.getElementById('remoteSearchInput');
  const btnRemoteUp = document.getElementById('btnRemoteUp');
  const btnRemoteRefresh = document.getElementById('btnRemoteRefresh');
  const btnRemoteMkdir = document.getElementById('btnRemoteMkdir');
  const btnRemoteRecent = document.getElementById('btnRemoteRecent');
  const btnRemoteUploadFolder = document.getElementById('btnRemoteUploadFolder');
  const btnRemoteUploadFiles = document.getElementById('btnRemoteUploadFiles');
  const btnUploadCurrentFolder = document.getElementById('btnUploadCurrentFolder');
  const termInput = document.getElementById('termInput');
  const btnExec = document.getElementById('btnExec');
  const remoteHostLabel = document.getElementById('remoteHostLabel');
  const floatingTermTitleText = document.getElementById('floatingTermTitleText');
  const termPromptLabel = document.getElementById('termPromptLabel');

  isConnected = status === 'connected';

  statusDot.className = `status-dot ${status}`;

  if (status === 'connected') {
    statusText.innerText = 'Connected';
    btnConnect.disabled = true;
    btnDisconnect.disabled = false;
    remoteSearchInput.disabled = false;
    btnRemoteUp.disabled = false;
    btnRemoteRefresh.disabled = false;
    btnRemoteMkdir.disabled = false;
    if (btnRemoteRecent) btnRemoteRecent.disabled = false;
    if (btnRemoteUploadFolder) btnRemoteUploadFolder.disabled = false;
    if (btnRemoteUploadFiles) btnRemoteUploadFiles.disabled = false;
    if (btnUploadCurrentFolder) btnUploadCurrentFolder.disabled = false;
    termInput.disabled = false;
    btnExec.disabled = false;

    const hostVal = document.getElementById('sshHost').value.trim();
    const userVal = document.getElementById('sshUser').value.trim();
    remoteHostLabel.innerText = `${userVal}@${hostVal}`;
    if (floatingTermTitleText) floatingTermTitleText.innerText = `SSH Terminal: ${userVal}@${hostVal}`;
    if (termPromptLabel) termPromptLabel.innerText = `${userVal}@${hostVal}:~$`;
    fetchRemoteFiles(currentRemotePath);
    renderLocalFiles(localFilesCache);
  } else if (status === 'connecting') {
    statusText.innerText = 'Connecting...';
    btnConnect.disabled = true;
    btnDisconnect.disabled = true;
    if (btnRemoteRecent) btnRemoteRecent.disabled = true;
    if (btnRemoteUploadFolder) btnRemoteUploadFolder.disabled = true;
    if (btnRemoteUploadFiles) btnRemoteUploadFiles.disabled = true;
    if (btnUploadCurrentFolder) btnUploadCurrentFolder.disabled = true;
  } else if (status === 'error') {
    statusText.innerText = 'Error';
    btnConnect.disabled = false;
    btnDisconnect.disabled = true;
    if (btnRemoteRecent) btnRemoteRecent.disabled = true;
    if (btnRemoteUploadFolder) btnRemoteUploadFolder.disabled = true;
    if (btnRemoteUploadFiles) btnRemoteUploadFiles.disabled = true;
    if (btnUploadCurrentFolder) btnUploadCurrentFolder.disabled = true;
  } else {
    statusText.innerText = 'Disconnected';
    btnConnect.disabled = false;
    btnDisconnect.disabled = true;
    remoteSearchInput.disabled = true;
    btnRemoteUp.disabled = true;
    btnRemoteRefresh.disabled = true;
    btnRemoteMkdir.disabled = true;
    if (btnRemoteRecent) btnRemoteRecent.disabled = true;
    if (btnRemoteUploadFolder) btnRemoteUploadFolder.disabled = true;
    if (btnRemoteUploadFiles) btnRemoteUploadFiles.disabled = true;
    if (btnUploadCurrentFolder) btnUploadCurrentFolder.disabled = true;
    termInput.disabled = true;
    btnExec.disabled = true;
    remoteHostLabel.innerText = 'Remote Host / SFTP Server';
    if (floatingTermTitleText) floatingTermTitleText.innerText = 'SSH Terminal (Disconnected)';
    if (termPromptLabel) termPromptLabel.innerText = 'user@remote:~$';

    document.getElementById('remoteFileBody').innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">
          <div class="empty-illustration">
            <i class="fa-solid fa-tower-broadcast"></i>
            <p>Enter connection parameters above and click <strong>Connect</strong> to explore remote files.</p>
          </div>
        </td>
      </tr>
    `;
    renderBreadcrumbs('remote', '/');
    renderLocalFiles(localFilesCache);
  }
}

function togglePasswordVisibility() {
  const passInput = document.getElementById('sshPassword');
  const icon = document.getElementById('passEyeIcon');
  if (passInput.type === 'password') {
    passInput.type = 'text';
    icon.className = 'fa-regular fa-eye-slash';
  } else {
    passInput.type = 'password';
    icon.className = 'fa-regular fa-eye';
  }
}

async function handleConnect(event) {
  event.preventDefault();

  const host = document.getElementById('sshHost').value.trim();
  const port = parseInt(document.getElementById('sshPort').value, 10) || 22;
  const username = document.getElementById('sshUser').value.trim();
  const password = document.getElementById('sshPassword').value;
  const privateKeyPath = document.getElementById('sshKeyPath').value.trim();
  const remember = document.getElementById('rememberPasswordCheck').checked;

  if (!host || !username) {
    showToast('error', 'Please enter Host IP and Username.');
    return;
  }

  // Clear previous error styles
  const passInput = document.getElementById('sshPassword');
  const userInput = document.getElementById('sshUser');
  if (passInput) passInput.classList.remove('input-error');
  if (userInput) userInput.classList.remove('input-error');

  // Update remembered password in active profile if checked
  const currentClient = savedClients.find(c => c.id === activeClientId);
  if (currentClient) {
    currentClient.rememberPassword = remember;
    currentClient.password = remember ? password : '';
    saveClientsToStorage();
  }

  updateConnectionUI('connecting');
  appendTerminalMsg('info', `Connecting to ${username}@${host}:${port}...`);
  showToast('info', `Connecting to ${username}@${host}:${port}...`);

  try {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, username, password, privateKeyPath }),
    });

    const result = await res.json();
    if (result.success) {
      if (result.remoteHome) {
        currentRemotePath = normalizePath(result.remoteHome);
      }
      appendTerminalMsg('info', `✅ SSH Connection established with ${username}@${host}:${port}`);
      showToast('success', `Connected to ${username}@${host}`);
      updateConnectionUI('connected');
    } else {
      appendTerminalMsg('stderr', `❌ Connection failed: ${result.error}`);
      showToast('error', result.error || 'Connection failed');
      updateConnectionUI('error');

      // Enhanced feedback for incorrect password / auth failure
      if (result.isAuthError) {
        if (passInput) {
          passInput.classList.add('input-error');
          passInput.focus();
          passInput.select();
        }
        if (userInput) {
          userInput.classList.add('input-error');
        }
        setTimeout(() => {
          if (passInput) passInput.classList.remove('input-error');
          if (userInput) userInput.classList.remove('input-error');
        }, 2200);
      }
    }
  } catch (err) {
    appendTerminalMsg('stderr', `❌ Network error: ${err.message}`);
    showToast('error', `Error: ${err.message}`);
    updateConnectionUI('error');
  }
}

async function handleDisconnect() {
  try {
    await fetch('/api/disconnect', { method: 'POST' });
    appendTerminalMsg('info', 'Disconnected from SSH server.');
    showToast('info', 'Disconnected from SSH.');
    updateConnectionUI('disconnected');
  } catch (err) {
    console.error('Error disconnecting:', err);
  }
}

// -------------------------------------------------------------
// 6. Local Filesystem Explorer & File Actions
// -------------------------------------------------------------
async function fetchInitialLocalDir() {
  try {
    const res = await fetch('/api/local-home');
    const data = await res.json();
    currentLocalPath = normalizePath(data.path);
    fetchLocalFiles(currentLocalPath);
  } catch (err) {
    console.error('Failed to get local home:', err);
  }
}

async function fetchLocalFiles(path) {
  try {
    const target = normalizePath(path || currentLocalPath);
    renderBreadcrumbs('local', target);
    const res = await fetch(`/api/list-local?path=${encodeURIComponent(target)}`);
    const data = await res.json();
    if (data.error) {
      showToast('error', `Failed to load local files: ${data.error}`);
      return;
    }
    currentLocalPath = normalizePath(data.currentPath || target);
    localFilesCache = data.files || (Array.isArray(data) ? data : []);
    applyLocalFileFilter();
  } catch (err) {
    showToast('error', `Failed to load local files: ${err.message}`);
  }
}

function isItemTransferring(filePath) {
  const normTarget = normalizePath(filePath);
  return activeTransfersCache.some(t => {
    if (t.status !== 'transferring' && t.status !== 'queued') return false;
    const lNorm = normalizePath(t.localPath);
    const rNorm = normalizePath(t.remotePath);
    return (
      lNorm === normTarget ||
      lNorm.startsWith(normTarget + '/') ||
      rNorm === normTarget ||
      rNorm.startsWith(normTarget + '/')
    );
  });
}

function renderLocalFiles(files) {
  const tbody = document.getElementById('localFileBody');
  if (!files || files.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><i class="fa-solid fa-folder-open"></i><p>No files found.</p></td></tr>';
    return;
  }

  tbody.innerHTML = files.map(file => {
    const isDir = file.type === 'directory';
    const iconClass = getFileIconClass(file.name, isDir);
    const sizeStr = isDir ? '--' : formatBytes(file.size);
    const dateStr = formatFileDate(file.modifyTime);
    const fullPath = joinPath(currentLocalPath, file.name);
    const transferring = isItemTransferring(fullPath);
    const recent = isItemRecent(file, fullPath);

    return `
      <tr class="${isDir ? 'dir-row' : ''} ${transferring ? 'row-transferring' : ''}" ${isDir ? `onclick="navigateLocalPath('${escapeHtml(fullPath)}')"` : ''}>
        <td class="col-icon"><i class="${iconClass}"></i></td>
        <td class="col-name" title="${escapeHtml(file.name)}">
          <div class="file-name-wrapper">
            <span class="file-name-text">${escapeHtml(file.name)}</span>
            ${recent ? `<span class="badge-recent"><i class="fa-solid fa-sparkles"></i> New</span>` : ''}
            ${transferring ? `<span class="badge-row-transferring"><i class="fa-solid fa-spinner fa-spin"></i></span>` : ''}
          </div>
        </td>
        <td class="col-size">${sizeStr}</td>
        <td class="col-date">${dateStr}</td>
        <td class="col-action" onclick="event.stopPropagation()">
          <div class="row-actions">
            ${!isDir ? `
              <button onclick="viewLocalFile('${escapeHtml(fullPath)}', '${escapeHtml(file.name)}')" class="btn-icon-action btn-view" title="Preview file">
                <i class="fa-solid fa-eye"></i>
              </button>
            ` : ''}
            ${isConnected ? (
              isDir ? `
                <button onclick="queueUploadFolder('${escapeHtml(fullPath)}', '${escapeHtml(file.name)}')" class="btn-icon-action btn-folder-up" title="Upload folder to remote server">
                  <i class="fa-solid fa-cloud-arrow-up"></i>
                </button>
              ` : `
                <button onclick="queueUpload('${escapeHtml(fullPath)}', '${escapeHtml(file.name)}')" class="btn-icon-action btn-upload" title="Upload file to remote server">
                  <i class="fa-solid fa-cloud-arrow-up"></i>
                </button>
              `
            ) : ''}
            <button onclick="deleteLocalItem('${escapeHtml(fullPath)}', ${isDir})" class="btn-icon-action btn-delete" title="Delete ${isDir ? 'folder' : 'file'} from local">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterLocalFiles(query) {
  applyLocalFileFilter();
}

function navigateLocalPath(path) {
  const norm = normalizePath(path);
  currentLocalPath = norm;
  fetchLocalFiles(norm);
}

function navigateLocalUp() {
  const parent = getParentPath(currentLocalPath, true);
  navigateLocalPath(parent);
}

function refreshLocal() {
  fetchLocalFiles(currentLocalPath);
}

async function promptCreateLocalDir() {
  const dirName = prompt('Enter new local directory name:');
  if (!dirName) return;
  const newPath = joinPath(currentLocalPath, dirName.trim());
  try {
    const res = await fetch('/api/mkdir-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localPath: normalizePath(newPath) }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('success', `Created local directory: ${dirName}`);
      refreshLocal();
    } else {
      showToast('error', `Error: ${data.error}`);
    }
  } catch (err) {
    showToast('error', `Error: ${err.message}`);
  }
}

async function deleteLocalItem(localPath, isDirectory) {
  const itemType = isDirectory ? 'folder' : 'file';
  const name = getPathBaseName(localPath);
  if (!confirm(`Are you sure you want to permanently delete local ${itemType} "${name}"?`)) return;
  try {
    const res = await fetch('/api/delete-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localPath: normalizePath(localPath), isDirectory }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('info', `Deleted local ${itemType}: ${name}`);
      refreshLocal();
    } else {
      showToast('error', `Error deleting local item: ${data.error}`);
    }
  } catch (err) {
    showToast('error', `Error: ${err.message}`);
  }
}

// -------------------------------------------------------------
// 7. Remote SFTP Explorer & File Actions
// -------------------------------------------------------------
async function fetchRemoteFiles(path) {
  if (!isConnected) return;
  try {
    const target = normalizePath(path || currentRemotePath);
    renderBreadcrumbs('remote', target);
    const dropLabel = document.getElementById('dropzonePathLabel');
    if (dropLabel) dropLabel.innerText = target;

    const res = await fetch(`/api/list-remote?path=${encodeURIComponent(target)}`);
    const data = await res.json();
    if (data.error) {
      showToast('error', `Remote error: ${data.error}`);
      return;
    }
    currentRemotePath = normalizePath(data.currentPath || target);
    remoteFilesCache = data.files || (Array.isArray(data) ? data : []);
    applyRemoteFileFilter();
  } catch (err) {
    showToast('error', `Failed to list remote directory: ${err.message}`);
  }
}

function renderRemoteFiles(files) {
  const tbody = document.getElementById('remoteFileBody');
  if (!files || files.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><div class="empty-illustration"><i class="fa-solid fa-tower-broadcast"></i><p>Enter connection parameters above and click <strong>Connect</strong> to explore remote files.</p></div></td></tr>';
    return;
  }

  tbody.innerHTML = files.map(file => {
    const isDir = file.type === 'directory';
    const iconClass = getFileIconClass(file.name, isDir);
    const sizeStr = isDir ? '--' : formatBytes(file.size);
    const dateStr = formatFileDate(file.modifyTime);
    const targetRemotePath = joinPath(currentRemotePath, file.name);
    const targetLocalPath = joinPath(currentLocalPath, file.name);
    const transferring = isItemTransferring(targetRemotePath);
    const recent = isItemRecent(file, targetRemotePath);

    return `
      <tr class="${isDir ? 'dir-row' : ''} ${transferring ? 'row-transferring' : ''}" ${isDir ? `onclick="navigateRemotePath('${escapeHtml(targetRemotePath)}')"` : ''}>
        <td class="col-icon"><i class="${iconClass}"></i></td>
        <td class="col-name" title="${escapeHtml(file.name)}">
          <div class="file-name-wrapper">
            <span class="file-name-text">${escapeHtml(file.name)}</span>
            ${recent ? `<span class="badge-recent"><i class="fa-solid fa-sparkles"></i> New</span>` : ''}
            ${transferring ? `<span class="badge-row-transferring"><i class="fa-solid fa-spinner fa-spin"></i></span>` : ''}
          </div>
        </td>
        <td class="col-size">${sizeStr}</td>
        <td class="col-date">${dateStr}</td>
        <td class="col-perm"><code>${file.permissions || ''}</code></td>
        <td class="col-action" onclick="event.stopPropagation()">
          <div class="row-actions">
            ${!isDir ? `
              <button onclick="viewRemoteFile('${escapeHtml(targetRemotePath)}', '${escapeHtml(file.name)}')" class="btn-icon-action btn-view" title="Preview remote file">
                <i class="fa-solid fa-eye"></i>
              </button>
            ` : ''}
            ${isDir ? `
              <button onclick="queueDownloadFolder('${escapeHtml(targetRemotePath)}', '${escapeHtml(file.name)}')" class="btn-icon-action btn-folder-down" title="Download folder to local">
                <i class="fa-solid fa-download"></i>
              </button>
            ` : `
              <button onclick="queueDownload('${escapeHtml(targetRemotePath)}', '${escapeHtml(targetLocalPath)}')" class="btn-icon-action btn-download" title="Download file to local">
                <i class="fa-solid fa-cloud-arrow-down"></i>
              </button>
            `}
            <button onclick="deleteRemoteItem('${escapeHtml(targetRemotePath)}', ${isDir})" class="btn-icon-action btn-delete" title="Delete from server">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterRemoteFiles(query) {
  applyRemoteFileFilter();
}

function navigateRemotePath(path) {
  const norm = normalizePath(path);
  currentRemotePath = norm;
  fetchRemoteFiles(norm);
}

function navigateRemoteUp() {
  const parent = getParentPath(currentRemotePath, false);
  navigateRemotePath(parent);
}

function refreshRemote() {
  fetchRemoteFiles(currentRemotePath);
}

async function promptCreateRemoteDir() {
  const dirName = prompt('Enter new remote directory name:');
  if (!dirName) return;
  const newPath = joinPath(currentRemotePath, dirName.trim());
  try {
    const res = await fetch('/api/mkdir-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remotePath: normalizePath(newPath) }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('success', `Directory created: ${dirName}`);
      refreshRemote();
    } else {
      showToast('error', `Error: ${data.error}`);
    }
  } catch (err) {
    showToast('error', `Error: ${err.message}`);
  }
}

async function deleteRemoteItem(remotePath, isDirectory) {
  const itemType = isDirectory ? 'folder' : 'file';
  const name = getPathBaseName(remotePath);
  if (!confirm(`Are you sure you want to permanently delete remote ${itemType} "${name}"?`)) return;
  try {
    const res = await fetch('/api/delete-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remotePath: normalizePath(remotePath), isDirectory }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('info', `Deleted remote ${itemType}: ${name}`);
      refreshRemote();
    } else {
      showToast('error', `Error deleting remote item: ${data.error}`);
    }
  } catch (err) {
    showToast('error', `Error: ${err.message}`);
  }
}

// -------------------------------------------------------------
// 8. In-App File Viewer Engine
// -------------------------------------------------------------
async function viewLocalFile(filePath, fileName) {
  openFileViewerModal(fileName, filePath, 'Local File');
  try {
    const res = await fetch(`/api/read-file-local?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.error) {
      renderViewerError(data.error);
      return;
    }
    renderViewerContent(data, filePath, fileName);
  } catch (err) {
    renderViewerError(err.message);
  }
}

async function viewRemoteFile(remotePath, fileName) {
  openFileViewerModal(fileName, remotePath, 'Remote SFTP File');
  try {
    const res = await fetch(`/api/read-file-remote?path=${encodeURIComponent(remotePath)}`);
    const data = await res.json();
    if (data.error) {
      renderViewerError(data.error);
      return;
    }
    renderViewerContent(data, remotePath, fileName);
  } catch (err) {
    renderViewerError(err.message);
  }
}

function openFileViewerModal(fileName, path, locationLabel) {
  activeViewerFile = { fileName, path, locationLabel, content: '' };
  const modal = document.getElementById('fileViewerModal');
  const title = document.getElementById('viewerFileName');
  const subtitle = document.getElementById('viewerMetaSubtitle');
  const pathLabel = document.getElementById('viewerFooterPath');
  const loader = document.getElementById('viewerLoading');
  const container = document.getElementById('viewerContentContainer');

  title.innerText = fileName;
  subtitle.innerText = `${locationLabel} • Loading...`;
  pathLabel.innerText = path;
  loader.style.display = 'flex';
  container.style.display = 'none';
  container.innerHTML = '';
  modal.classList.add('open');
}

function closeFileViewer() {
  document.getElementById('fileViewerModal').classList.remove('open');
  activeViewerFile = null;
}

function renderViewerContent(data, path, fileName) {
  const loader = document.getElementById('viewerLoading');
  const container = document.getElementById('viewerContentContainer');
  const subtitle = document.getElementById('viewerMetaSubtitle');
  const copyBtn = document.getElementById('btnCopyViewer');

  loader.style.display = 'none';
  container.style.display = 'block';

  const sizeFormatted = formatBytes(data.size);
  const dateFormatted = data.mtime ? formatFileDate(data.mtime) : 'Recent';
  subtitle.innerText = `${activeViewerFile.locationLabel} • ${sizeFormatted} • Modified ${dateFormatted}`;

  if (data.isImage && data.dataUrl) {
    activeViewerFile.content = '';
    copyBtn.style.display = 'none';
    container.innerHTML = `
      <div class="viewer-img-container">
        <img src="${data.dataUrl}" alt="${escapeHtml(fileName)}">
      </div>
    `;
  } else if (data.isText && data.content !== undefined) {
    activeViewerFile.content = data.content;
    copyBtn.style.display = 'inline-flex';
    container.innerHTML = `
      <pre class="viewer-code-block"><code>${escapeHtml(data.content)}</code></pre>
    `;
  } else if (data.isBinary) {
    activeViewerFile.content = '';
    copyBtn.style.display = 'none';
    container.innerHTML = `
      <div class="viewer-binary-container">
        <i class="fa-solid fa-file-zipper viewer-binary-icon"></i>
        <h3>Binary / Media File</h3>
        <p>This file is binary or compressed and cannot be previewed as text.</p>
        <button class="btn btn-primary btn-sm" onclick="downloadViewerFile()"><i class="fa-solid fa-download"></i> Download to Inspect</button>
      </div>
    `;
  }
}

function renderViewerError(errMsg) {
  const loader = document.getElementById('viewerLoading');
  const container = document.getElementById('viewerContentContainer');
  loader.style.display = 'none';
  container.style.display = 'block';
  container.innerHTML = `
    <div class="viewer-binary-container">
      <i class="fa-solid fa-triangle-exclamation viewer-binary-icon" style="color: var(--accent-rose);"></i>
      <h3>Unable to Preview File</h3>
      <p style="color: var(--accent-rose);">${escapeHtml(errMsg)}</p>
    </div>
  `;
}

function copyViewerContent() {
  if (activeViewerFile && activeViewerFile.content) {
    copyText(activeViewerFile.content);
    showToast('success', 'File content copied to clipboard!');
  } else {
    showToast('info', 'No text content to copy.');
  }
}

function downloadViewerFile() {
  if (!activeViewerFile) return;
  if (activeViewerFile.locationLabel.includes('Local')) {
    showToast('info', `File is located locally at: ${activeViewerFile.path}`);
  } else {
    queueDownload(activeViewerFile.path, `${currentLocalPath}/${activeViewerFile.fileName}`.replace(/\/+/g, '/'));
    showToast('success', `Queued download for ${activeViewerFile.fileName}`);
    closeFileViewer();
  }
}

// -------------------------------------------------------------
// 9. Universal Browser & Drag-and-Drop Folder Upload
// -------------------------------------------------------------
function triggerBrowserFolderUpload() {
  if (!isConnected) {
    showToast('error', 'Connect to SSH / SFTP server first!');
    return;
  }
  const input = document.getElementById('browserFolderInput');
  if (input) {
    input.value = '';
    input.click();
  }
}

function triggerBrowserFileUpload() {
  if (!isConnected) {
    showToast('error', 'Connect to SSH / SFTP server first!');
    return;
  }
  const input = document.getElementById('browserFileInput');
  if (input) {
    input.value = '';
    input.click();
  }
}

async function handleBrowserFolderSelected(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;
  uploadBrowserFilesList(files);
}

async function handleBrowserFilesSelected(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;
  uploadBrowserFilesList(files);
}

async function uploadBrowserFilesList(fileList) {
  const count = fileList.length;
  const totalBytes = fileList.reduce((sum, f) => sum + f.size, 0);
  const sizeFormatted = formatBytes(totalBytes);

  showToast('info', `📤 Uploading ${count} items (${sizeFormatted}) to ${currentRemotePath}...`);

  let uploadedCount = 0;
  let failedCount = 0;

  for (const file of fileList) {
    const relativePath = file.webkitRelativePath || file.name;
    const destPath = currentRemotePath === '.' 
      ? relativePath 
      : `${currentRemotePath}/${relativePath}`.replace(/\/+/g, '/');

    try {
      const res = await fetch(`/api/upload-stream?remotePath=${encodeURIComponent(destPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const data = await res.json();
      if (data.success) {
        uploadedCount++;
        recentlyTransferredPaths.add(destPath);
        recentlyTransferredPaths.add(file.name);
      } else {
        failedCount++;
      }
    } catch (e) {
      failedCount++;
    }
  }

  if (failedCount === 0) {
    showToast('success', `✅ Finished uploading ${uploadedCount} items to remote folder.`);
  } else {
    showToast('info', `Uploaded ${uploadedCount} items (${failedCount} failed).`);
  }

  refreshRemote();
}

function initDragAndDrop() {
  const panel = document.getElementById('remoteExplorerPanel');
  const overlay = document.getElementById('remoteDropzoneOverlay');
  if (!panel || !overlay) return;

  let dragCounter = 0;

  panel.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isConnected) return;
    dragCounter++;
    overlay.classList.add('active');
  });

  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  panel.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      overlay.classList.remove('active');
    }
  });

  panel.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    overlay.classList.remove('active');

    if (!isConnected) {
      showToast('error', 'Connect to SSH / SFTP server first!');
      return;
    }

    const items = e.dataTransfer.items;
    if (!items || items.length === 0) return;

    showToast('info', 'Scanning dropped files and folders...');
    const filesToUpload = [];

    const traverseEntry = async (entry, currentPath = '') => {
      if (entry.isFile) {
        const file = await new Promise(resolve => entry.file(resolve));
        file._fullRelativePath = currentPath ? `${currentPath}/${file.name}` : file.name;
        filesToUpload.push(file);
      } else if (entry.isDirectory) {
        const dirReader = entry.createReader();
        const readEntries = async () => {
          return new Promise(resolve => {
            dirReader.readEntries(async (entries) => {
              if (entries.length === 0) {
                resolve();
              } else {
                for (const child of entries) {
                  await traverseEntry(child, currentPath ? `${currentPath}/${entry.name}` : entry.name);
                }
                await readEntries();
                resolve();
              }
            });
          });
        };
        await readEntries();
      }
    };

    const promises = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (entry) {
        promises.push(traverseEntry(entry));
      }
    }

    await Promise.all(promises);

    if (filesToUpload.length > 0) {
      uploadCustomFileList(filesToUpload);
    }
  });
}

async function uploadCustomFileList(fileList) {
  const count = fileList.length;
  const totalBytes = fileList.reduce((sum, f) => sum + f.size, 0);
  const sizeFormatted = formatBytes(totalBytes);

  showToast('info', `📤 Uploading ${count} dropped items (${sizeFormatted}) to ${currentRemotePath}...`);

  let uploadedCount = 0;
  let failedCount = 0;

  for (const file of fileList) {
    const relativePath = file._fullRelativePath || file.name;
    const destPath = currentRemotePath === '.' 
      ? relativePath 
      : `${currentRemotePath}/${relativePath}`.replace(/\/+/g, '/');

    try {
      const res = await fetch(`/api/upload-stream?remotePath=${encodeURIComponent(destPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const data = await res.json();
      if (data.success) {
        uploadedCount++;
        recentlyTransferredPaths.add(destPath);
        recentlyTransferredPaths.add(file.name);
      } else {
        failedCount++;
      }
    } catch (e) {
      failedCount++;
    }
  }

  if (failedCount === 0) {
    showToast('success', `✅ Finished uploading ${uploadedCount} items to remote folder.`);
  } else {
    showToast('info', `Uploaded ${uploadedCount} items (${failedCount} failed).`);
  }

  refreshRemote();
}

// -------------------------------------------------------------
// 10. Breadcrumbs Navigation
// -------------------------------------------------------------
function renderBreadcrumbs(type, fullPath) {
  const container = document.getElementById(`${type}Breadcrumb`);
  if (!container) return;

  const norm = normalizePath(fullPath);
  const isWindowsDrive = /^[a-zA-Z]:/.test(norm);
  const navFn = type === 'local' ? 'navigateLocalPath' : 'navigateRemotePath';

  if (isWindowsDrive && type === 'local') {
    const driveMatch = norm.match(/^([a-zA-Z]:)/);
    const drive = driveMatch ? driveMatch[1] + '/' : 'C:/';
    const subPath = norm.substring(driveMatch ? driveMatch[1].length : 2);
    const parts = subPath.split('/').filter(Boolean);

    let html = `<span class="breadcrumb-item ${parts.length === 0 ? 'active' : ''}" onclick="${navFn}('${escapeHtml(drive)}')">${escapeHtml(drive)}</span>`;
    let accumulated = drive.slice(0, -1);

    parts.forEach((part, idx) => {
      accumulated += '/' + part;
      const isLast = idx === parts.length - 1;
      const target = accumulated;
      html += `
        <span class="breadcrumb-sep">/</span>
        <span class="breadcrumb-item ${isLast ? 'active' : ''}" onclick="${navFn}('${escapeHtml(target)}')">${escapeHtml(part)}</span>
      `;
    });
    container.innerHTML = html;
  } else {
    const parts = norm.split('/').filter(Boolean);
    let html = `<span class="breadcrumb-item ${parts.length === 0 ? 'active' : ''}" onclick="${navFn}('/')">/</span>`;
    let accumulated = '';

    parts.forEach((part, idx) => {
      accumulated += '/' + part;
      const isLast = idx === parts.length - 1;
      const target = accumulated;
      html += `
        <span class="breadcrumb-sep">/</span>
        <span class="breadcrumb-item ${isLast ? 'active' : ''}" onclick="${navFn}('${escapeHtml(target)}')">${escapeHtml(part)}</span>
      `;
    });
    container.innerHTML = html;
  }
}

// -------------------------------------------------------------
// 11. Transfer Queue Engine & Local Directory Upload
// -------------------------------------------------------------
async function queueUpload(localPath, fileName) {
  const remotePath = joinPath(currentRemotePath, fileName);
  try {
    await fetch('/api/enqueue-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localPath: normalizePath(localPath),
        remotePath: normalizePath(remotePath),
        direction: 'upload'
      }),
    });
    showToast('info', `Queued upload: ${fileName}`);
    switchDockTab('transfers');
    fetchTransfers();
  } catch (err) {
    showToast('error', `Upload error: ${err.message}`);
  }
}

async function queueUploadFolder(localDir, dirName) {
  if (!isConnected) {
    showToast('error', 'Connect to SSH / SFTP server first!');
    return;
  }
  showToast('info', `Scanning and queueing folder: ${dirName}...`);
  try {
    const res = await fetch('/api/enqueue-dir-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localDir: normalizePath(localDir),
        remoteDir: normalizePath(currentRemotePath)
      }),
    });
    const data = await res.json();
    if (data.success) {
      const sizeStr = formatBytes(data.totalBytes);
      showToast('success', `📁 Queued folder "${dirName}" (${data.count} files, ${sizeStr})`);
      switchDockTab('transfers');
      fetchTransfers();
    } else {
      showToast('error', `Folder upload failed: ${data.error}`);
    }
  } catch (err) {
    showToast('error', `Error queueing folder upload: ${err.message}`);
  }
}

async function uploadCurrentLocalFolder() {
  if (!currentLocalPath) return;
  const dirName = getPathBaseName(currentLocalPath) || 'current_dir';
  queueUploadFolder(currentLocalPath, dirName);
}

async function queueDownload(remotePath, localPath) {
  try {
    await fetch('/api/enqueue-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localPath: normalizePath(localPath),
        remotePath: normalizePath(remotePath),
        direction: 'download'
      }),
    });
    showToast('info', `Queued download: ${remotePath}`);
    switchDockTab('transfers');
    fetchTransfers();
  } catch (err) {
    showToast('error', `Download error: ${err.message}`);
  }
}

async function queueDownloadFolder(remoteDir, dirName) {
  showToast('info', `Scanning and downloading folder: ${dirName}...`);
  try {
    const res = await fetch('/api/enqueue-dir-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        remoteDir: normalizePath(remoteDir),
        localDir: normalizePath(currentLocalPath)
      }),
    });
    const data = await res.json();
    if (data.success) {
      const sizeStr = formatBytes(data.totalBytes);
      showToast('success', `📁 Queued folder download "${dirName}" (${data.count} files, ${sizeStr})`);
      switchDockTab('transfers');
      fetchTransfers();
    } else {
      showToast('error', `Folder download failed: ${data.error}`);
    }
  } catch (err) {
    showToast('error', `Error downloading folder: ${err.message}`);
  }
}

async function fetchTransfers() {
  try {
    const res = await fetch('/api/transfers');
    const tasks = await res.json();
    renderTransfersList(tasks);
  } catch (err) {}
}

function renderTransfersList(tasks) {
  activeTransfersCache = tasks || [];
  const activeTasks = activeTransfersCache.filter(t => t.status === 'transferring' || t.status === 'queued');
  const completedTasks = activeTransfersCache.filter(t => t.status === 'completed');
  const failedTasks = activeTransfersCache.filter(t => t.status === 'failed');

  const badge = document.getElementById('transferBadge');
  if (badge) badge.innerText = activeTasks.length;

  const dockSummaryText = document.getElementById('dockSummaryText');
  const dockTransferDot = document.getElementById('dockTransferDot');
  if (dockSummaryText) {
    dockSummaryText.innerText = `${activeTasks.length} active (${completedTasks.length} completed, ${failedTasks.length} failed)`;
  }
  if (dockTransferDot) {
    dockTransferDot.className = activeTasks.length > 0 ? 'status-indicator-dot active' : 'status-indicator-dot';
  }

  updateTransferHud(activeTasks);

  const tbody = document.getElementById('queueBody');
  if (!tbody) return;

  if (!tasks || tasks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-queue-msg"><i class="fa-solid fa-inbox"></i> No file transfers in progress. Click <strong>Upload</strong> or <strong>Download</strong> on any file or folder.</td></tr>';
    return;
  }

  tbody.innerHTML = tasks.map(task => {
    const isUp = task.direction === 'upload';
    const badgeClass = isUp ? 'badge-upload' : 'badge-download';
    const dirIcon = isUp ? '<i class="fa-solid fa-arrow-up"></i> Upload' : '<i class="fa-solid fa-arrow-down"></i> Download';
    const sizeDisplay = `${task.transferredFormatted || formatBytes(task.transferredBytes)} / ${task.totalFormatted || formatBytes(task.totalBytes)}`;

    let statusHtml = `<strong>${task.status}</strong>`;
    if (task.status === 'transferring') {
      statusHtml = `<span style="color: var(--accent-cyan);"><i class="fa-solid fa-spinner fa-spin"></i> Transferring</span>`;
    } else if (task.status === 'completed') {
      statusHtml = `<span style="color: var(--accent-emerald);"><i class="fa-solid fa-circle-check"></i> Completed</span>`;
    } else if (task.status === 'failed') {
      statusHtml = `<span style="color: var(--accent-rose);" title="${escapeHtml(task.error || '')}"><i class="fa-solid fa-circle-xmark"></i> Failed</span>`;
    } else if (task.status === 'cancelled') {
      statusHtml = `<span style="color: var(--text-dim);"><i class="fa-solid fa-ban"></i> Cancelled</span>`;
    }

    return `
      <tr class="${task.status === 'transferring' ? 'row-transferring' : ''}">
        <td><strong>${escapeHtml(task.fileName)}</strong></td>
        <td><span class="${badgeClass}">${dirIcon}</span></td>
        <td><code>${escapeHtml(task.localPath)}</code></td>
        <td><code>${escapeHtml(task.remotePath)}</code></td>
        <td>
          <div class="progress-track">
            <div class="progress-fill" style="width: ${task.percentage}%"></div>
          </div>
          <span style="font-size: 10px; font-family: monospace;">${task.percentage}%</span>
        </td>
        <td style="font-family: var(--font-mono); font-size: 11px; white-space: nowrap;">${sizeDisplay}</td>
        <td style="font-family: var(--font-mono);">${task.speedFormatted || '0 B/s'}</td>
        <td style="font-family: var(--font-mono);">${task.etaFormatted || '--'}</td>
        <td>${statusHtml}</td>
        <td>
          ${task.status === 'transferring' || task.status === 'queued' ? `
            <button onclick="cancelTransfer('${task.id}')" class="btn-file-del" title="Cancel">Cancel</button>
          ` : '--'}
        </td>
      </tr>
    `;
  }).join('');
}

function updateTransferHud(activeTasks) {
  const hud = document.getElementById('transferHud');
  if (!hud) return;

  if (!activeTasks || activeTasks.length === 0) {
    hud.classList.remove('visible');
    return;
  }

  hud.classList.add('visible');

  const currentTask = activeTasks.find(t => t.status === 'transferring') || activeTasks[0];
  const isUp = currentTask.direction === 'upload';

  const hudOrbIcon = document.getElementById('hudOrbIcon');
  if (hudOrbIcon) {
    hudOrbIcon.className = isUp ? 'fa-solid fa-cloud-arrow-up hud-orb-icon' : 'fa-solid fa-cloud-arrow-down hud-orb-icon';
  }

  const hudDirectionBadge = document.getElementById('hudDirectionBadge');
  if (hudDirectionBadge) {
    hudDirectionBadge.className = isUp ? 'hud-badge-direction' : 'hud-badge-direction download';
    hudDirectionBadge.innerHTML = isUp ? '<i class="fa-solid fa-arrow-up"></i> UPLOADING' : '<i class="fa-solid fa-arrow-down"></i> DOWNLOADING';
  }

  const hudFileName = document.getElementById('hudFileName');
  if (hudFileName) hudFileName.innerText = currentTask.fileName;

  const hudBatchCounter = document.getElementById('hudBatchCounter');
  if (hudBatchCounter) hudBatchCounter.innerText = `${activeTasks.length} item${activeTasks.length > 1 ? 's' : ''} in queue`;

  const hudTransferredSize = document.getElementById('hudTransferredSize');
  if (hudTransferredSize) hudTransferredSize.innerText = currentTask.transferredFormatted || formatBytes(currentTask.transferredBytes);

  const hudTotalSize = document.getElementById('hudTotalSize');
  if (hudTotalSize) hudTotalSize.innerText = currentTask.totalFormatted || formatBytes(currentTask.totalBytes);

  const hudSpeed = document.getElementById('hudSpeed');
  if (hudSpeed) hudSpeed.innerText = currentTask.speedFormatted || '0 B/s';

  const hudEta = document.getElementById('hudEta');
  if (hudEta) hudEta.innerText = currentTask.etaFormatted || '--:--';

  const hudProgressFill = document.getElementById('hudProgressFill');
  if (hudProgressFill) hudProgressFill.style.width = `${currentTask.percentage}%`;

  const hudPctText = document.getElementById('hudPctText');
  if (hudPctText) hudPctText.innerText = `${currentTask.percentage}%`;
}

async function cancelTransfer(taskId) {
  try {
    await fetch('/api/cancel-transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
    fetchTransfers();
  } catch (err) {}
}

async function clearCompletedTransfers() {
  try {
    await fetch('/api/clear-completed-transfers', { method: 'POST' });
    showToast('info', 'Cleared completed transfers.');
    fetchTransfers();
  } catch (err) {
    console.error('Failed to clear transfers:', err);
  }
}

// -------------------------------------------------------------
// 12. Detachable Floating SSH Terminal Window Engine
// -------------------------------------------------------------
function toggleDetachTerminal() {
  if (isTerminalDetached) {
    dockTerminal();
  } else {
    detachTerminal();
  }
}

function detachTerminal() {
  const container = document.getElementById('terminalViewContainer');
  const floatingBody = document.getElementById('floatingTermBody');
  const floatingWindow = document.getElementById('floatingTerminalWindow');
  const dockTabTerminal = document.getElementById('dockTabTerminal');
  const detachLabel = document.getElementById('detachBtnLabel');

  if (!container || !floatingBody || !floatingWindow) return;

  floatingBody.appendChild(container);
  floatingWindow.classList.add('open');
  isTerminalDetached = true;

  if (detachLabel) detachLabel.innerText = 'Dock Back';

  if (dockTabTerminal) {
    dockTabTerminal.innerHTML = `
      <div class="terminal-detached-placeholder">
        <i class="fa-solid fa-up-right-from-square"></i>
        <p>SSH Terminal is currently detached into a floating window.</p>
        <button class="btn-mini btn-dock-back" onclick="dockTerminal()"><i class="fa-solid fa-down-left-and-up-right-to-center"></i> Return / Dock Back</button>
      </div>
    `;
  }

  showToast('info', 'Terminal detached into floating window');
}

function dockTerminal() {
  const container = document.getElementById('terminalViewContainer');
  const dockTabTerminal = document.getElementById('dockTabTerminal');
  const floatingWindow = document.getElementById('floatingTerminalWindow');
  const detachLabel = document.getElementById('detachBtnLabel');

  if (!container || !dockTabTerminal || !floatingWindow) return;

  dockTabTerminal.innerHTML = '';
  dockTabTerminal.appendChild(container);
  floatingWindow.classList.remove('open', 'maximized', 'minimized');
  isTerminalDetached = false;
  isTerminalMaximized = false;
  isTerminalMinimized = false;

  if (detachLabel) detachLabel.innerText = 'Detach';

  switchDockTab('terminal');
  showToast('info', 'Terminal returned to bottom dock');
}

function maximizeFloatingTerminal() {
  const floatingWindow = document.getElementById('floatingTerminalWindow');
  const btnMax = document.getElementById('btnMaxFloat');
  if (!floatingWindow) return;

  isTerminalMaximized = !isTerminalMaximized;
  floatingWindow.classList.toggle('maximized', isTerminalMaximized);

  if (btnMax) {
    btnMax.innerHTML = isTerminalMaximized ? '<i class="fa-solid fa-compress"></i>' : '<i class="fa-solid fa-expand"></i>';
  }
}

function minimizeFloatingTerminal() {
  const floatingWindow = document.getElementById('floatingTerminalWindow');
  if (!floatingWindow) return;

  isTerminalMinimized = !isTerminalMinimized;
  floatingWindow.classList.toggle('minimized', isTerminalMinimized);
}

function initFloatingWindowDrag() {
  const win = document.getElementById('floatingTerminalWindow');
  const header = document.getElementById('floatingTermHeader');
  const resizer = document.getElementById('floatingTermResizer');
  if (!win || !header) return;

  let isDragging = false;
  let startX = 0, startY = 0;
  let initialLeft = 0, initialTop = 0;

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.closest('.term-font-adjuster') || isTerminalMaximized) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = win.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (isDragging) {
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      win.style.left = `${Math.max(10, Math.min(window.innerWidth - 150, initialLeft + deltaX))}px`;
      win.style.top = `${Math.max(10, Math.min(window.innerHeight - 80, initialTop + deltaY))}px`;
    }
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.userSelect = '';
    }
  });

  if (resizer) {
    let isResizing = false;
    let rStartX = 0, rStartY = 0;
    let initialW = 0, initialH = 0;

    resizer.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      isResizing = true;
      rStartX = e.clientX;
      rStartY = e.clientY;
      const rect = win.getBoundingClientRect();
      initialW = rect.width;
      initialH = rect.height;
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (isResizing) {
        const deltaW = e.clientX - rStartX;
        const deltaH = e.clientY - rStartY;
        win.style.width = `${Math.max(440, initialW + deltaW)}px`;
        win.style.height = `${Math.max(260, initialH + deltaH)}px`;
      }
    });

    window.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.userSelect = '';
      }
    });
  }
}

// -------------------------------------------------------------
// 13. SSH Remote Terminal Execution & History
// -------------------------------------------------------------
function setupTerminalHistory() {
  const input = document.getElementById('termInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0 && historyIndex < commandHistory.length - 1) {
        historyIndex++;
        input.value = commandHistory[commandHistory.length - 1 - historyIndex];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        historyIndex--;
        input.value = commandHistory[commandHistory.length - 1 - historyIndex];
      } else if (historyIndex === 0) {
        historyIndex = -1;
        input.value = '';
      }
    }
  });
}

function execQuickCommand(cmd) {
  if (!isConnected) {
    showToast('error', 'Connect to SSH host first!');
    return;
  }
  document.getElementById('termInput').value = cmd;
  handleExecCommand(new Event('submit'));
}

async function handleExecCommand(event) {
  event.preventDefault();
  const input = document.getElementById('termInput');
  const command = input.value.trim();
  if (!command) return;

  commandHistory.push(command);
  historyIndex = -1;

  appendTerminalMsg('command', `$ ${command}`);
  input.value = '';

  try {
    const res = await fetch('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    const result = await res.json();
    if (result.stdout) {
      appendTerminalMsg('stdout', result.stdout);
    }
    if (result.stderr) {
      appendTerminalMsg('stderr', result.stderr);
    }
    if (result.exitCode !== 0) {
      appendTerminalMsg('info', `Exit status: ${result.exitCode}`);
    }
  } catch (err) {
    appendTerminalMsg('stderr', `Execution failed: ${err.message}`);
  }
}

function appendTerminalMsg(type, text) {
  const container = document.getElementById('terminalOutput');
  const div = document.createElement('div');
  div.className = `term-msg ${type}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function clearTerminal() {
  document.getElementById('terminalOutput').innerHTML = '';
}

// -------------------------------------------------------------
// 14. Dock Tab Switching & UI Utilities
// -------------------------------------------------------------
function switchDockTab(tab) {
  document.getElementById('dockBtnTransfers').classList.toggle('active', tab === 'transfers');
  document.getElementById('dockBtnTerminal').classList.toggle('active', tab === 'terminal');
  document.getElementById('dockTabTransfers').classList.toggle('active', tab === 'transfers');
  document.getElementById('dockTabTerminal').classList.toggle('active', tab === 'terminal');
}

function formatFileDate(dateVal) {
  if (!dateVal) return '--';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return '--';

  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();

  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  if (isToday) {
    return `Today ${timeStr}`;
  }
  if (isYesterday) {
    return `Yday ${timeStr}`;
  }

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (d.getFullYear() === now.getFullYear()) {
    return `${months[d.getMonth()]} ${d.getDate()} ${timeStr}`;
  }

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getFileIconClass(name, isDir) {
  if (isDir) return 'fa-solid fa-folder file-icon folder';
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'ts':
    case 'py':
    case 'c':
    case 'cpp':
    case 'sh':
    case 'html':
    case 'css':
      return 'fa-solid fa-file-code file-icon code';
    case 'json':
    case 'yaml':
    case 'yml':
    case 'xml':
      return 'fa-solid fa-file-lines file-icon text';
    case 'zip':
    case 'tar':
    case 'gz':
    case '7z':
      return 'fa-solid fa-file-zipper file-icon archive';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return 'fa-solid fa-file-image file-icon image';
    default:
      return 'fa-solid fa-file file-icon text';
  }
}

function showToast(type, message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icon = type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info';
  toast.innerHTML = `<i class="fa-solid ${icon}"></i><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
