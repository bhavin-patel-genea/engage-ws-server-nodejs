'use strict';

(function bootstrapAccessUi() {
  const UNSUPPORTED_FLAGS = [
    'is_parity_calculation_by_2_bits',
    'is_special_card_format',
    'is_large_encoded_id',
    'is_37_bit_special_parity_test',
    'is_37_bit_parity_test_with_4_bits',
    'is_37_bit_parity_test_with_2_bits',
    'is_200_bit_fascn_to_128_bit_version_conversation',
    'is_card_id_check_with_other_formats',
    'is_corporate_card',
    'enable_corporate_1000_parity_checks',
  ];

  const LOCK_SETTING_DEFAULTS = {
    invCrdAudEn: false,
    auditIDEn: false,
    proxConfHID: false,
    proxConfGECASI: false,
    proxConfAWID: false,
    uid14443: false,
    mi14443: false,
    mip14443: false,
    noc14443: false,
    uid15693: false,
    iClsUID40b: false,
    geProxFormat: 'disabled',
  };

  const LOCK_SETTING_GROUPS = [
    {
      title: 'Audit Visibility',
      helper: 'Turn on invalid credential audit if you want denied or unknown card swipes to create audits on the lock.',
      items: [
        {
          key: 'invCrdAudEn',
          type: 'toggle',
          label: 'Invalid credential audit',
          note: 'Emit denied and unknown-card audit events from the lock.',
        },
        {
          key: 'auditIDEn',
          type: 'toggle',
          label: 'Audit ID tracking',
          note: 'Include audit identifiers for downstream processing.',
        },
      ],
    },
    {
      title: 'Reader Technologies',
      helper: 'Match these reader flags to the card technology this lock should accept.',
      items: [
        {
          key: 'proxConfHID',
          type: 'toggle',
          label: 'HID prox',
          note: 'Enable standard HID prox credentials on the reader.',
        },
        {
          key: 'geProxFormat',
          type: 'select',
          label: 'GE prox format',
          note: 'Choose the supported GE prox bit layout for this lock.',
          options: [
            { value: 'disabled', label: 'Disabled' },
            { value: '4001', label: 'GE 4001' },
            { value: '4002', label: 'GE 4002' },
          ],
        },
        {
          key: 'proxConfAWID',
          type: 'toggle',
          label: 'AWID prox',
          note: 'Enable AWID low-frequency prox cards.',
        },
        {
          key: 'proxConfGECASI',
          type: 'toggle',
          label: 'GE CASI prox',
          note: 'Enable GE CASI prox credentials.',
        },
        {
          key: 'uid14443',
          type: 'toggle',
          label: '14443 UID',
          note: 'Read ISO 14443 UID values directly.',
        },
        {
          key: 'mi14443',
          type: 'toggle',
          label: 'MIFARE / 14443',
          note: 'Enable standard MIFARE-based 14443 credentials.',
        },
        {
          key: 'mip14443',
          type: 'toggle',
          label: 'MIFARE Plus / 14443',
          note: 'Enable MIFARE Plus credential support.',
        },
        {
          key: 'noc14443',
          type: 'toggle',
          label: 'No-card / 14443',
          note: 'Enable the configured 14443 no-card mode.',
        },
        {
          key: 'uid15693',
          type: 'toggle',
          label: '15693 UID',
          note: 'Read ISO 15693 UID values directly.',
        },
        {
          key: 'iClsUID40b',
          type: 'toggle',
          label: 'iCLASS UID 40-bit',
          note: 'Enable iCLASS UID 40-bit credential support.',
        },
      ],
    },
  ];

  const accessState = {
    users: [],
    schedules: [],
    builtInCardFormats: [],
    customCardFormats: [],
    selectedLockId: null,
    selectedGatewaySn: null,
    preview: null,
    loaded: false,
    userFormatTouched: false,
    lockSettingsValues: { ...LOCK_SETTING_DEFAULTS },
    lockSettingsBaseline: { ...LOCK_SETTING_DEFAULTS },
    lockSettingsSupported: {},
    lockSettingsFetchedAt: null,
    lockSettingsLoading: false,
    lockSettingsSaving: false,
    lockSettingsError: '',
    lockSettingsLockKey: null,
    lockSettingsRequestToken: 0,
  };

  function liveLocks() {
    return Object.entries(state.devices).flatMap(([sn, list]) =>
      list.map(lock => ({ sn, ...lock }))
    );
  }

  function selectedLock() {
    return liveLocks().find(lock =>
      lock.linkId === accessState.selectedLockId &&
      lock.sn === accessState.selectedGatewaySn
    ) || null;
  }

  function lockKey(lock) {
    return lock ? `${lock.sn}:${lock.linkId}` : null;
  }

  function cloneLockSettingsValues(values = {}) {
    return {
      ...LOCK_SETTING_DEFAULTS,
      ...values,
      geProxFormat: ['4001', '4002', 'disabled'].includes(String(values.geProxFormat || '').trim())
        ? String(values.geProxFormat).trim()
        : 'disabled',
    };
  }

  function setLockSettingsState(payload = {}) {
    accessState.lockSettingsValues = cloneLockSettingsValues(payload.values || {});
    accessState.lockSettingsBaseline = cloneLockSettingsValues(payload.values || {});
    accessState.lockSettingsSupported = { ...(payload.supported || {}) };
    accessState.lockSettingsFetchedAt = payload.fetchedAt || null;
    accessState.lockSettingsError = '';
  }

  function lockSettingsSignature(values) {
    return JSON.stringify(cloneLockSettingsValues(values || {}));
  }

  function hasLockSettingsChanges() {
    return lockSettingsSignature(accessState.lockSettingsValues) !== lockSettingsSignature(accessState.lockSettingsBaseline);
  }

  function expandAccessSection(collapseKey) {
    const header = document.querySelector(`.section-header.collapsible[data-collapse-key="${collapseKey}"]`);
    if (!header) return;
    const body = header.nextElementSibling;
    header.classList.remove('collapsed');
    if (body) body.classList.remove('collapsed');
    try {
      sessionStorage.removeItem(`collapse_${collapseKey}`);
    } catch {
      // ignore session storage issues
    }
  }

  function expandLockSettingsSections() {
    expandAccessSection('lock-settings');
    expandAccessSection('lock-settings-live');
  }

  function isUnsupportedFormat(format) {
    const payload = format?.payload || {};
    return payload.format !== 'WIEGAND' || UNSUPPORTED_FLAGS.some(flag => payload[flag]);
  }

  function cardFormats() {
    return [
      ...accessState.builtInCardFormats.map(format => ({ ...format, source: 'builtin', id: format.value })),
      ...accessState.customCardFormats.map(format => ({ ...format, source: 'custom', id: format.id })),
    ];
  }

  function supportedCardFormats() {
    return cardFormats().filter(format => !isUnsupportedFormat(format));
  }

  function pushStateFor(linkId) {
    return state.databasePushStates?.[linkId] || null;
  }

  function ensureSelection() {
    const locks = liveLocks();
    const current = selectedLock();
    if (current) return;
    if (locks.length > 0) {
      accessState.selectedLockId = locks[0].linkId;
      accessState.selectedGatewaySn = locks[0].sn;
    } else {
      accessState.selectedLockId = null;
      accessState.selectedGatewaySn = null;
    }
  }

  function parseDecimalBigInt(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (!/^\d+$/.test(raw)) return null;
    return BigInt(raw);
  }

  function maxValueForBits(bitCount) {
    if (!bitCount || bitCount <= 0) return 0n;
    return (1n << BigInt(bitCount)) - 1n;
  }

  function formatRefValue(source, id) {
    return `${source}:${id}`;
  }

  function findFormat(source, id) {
    return cardFormats().find(format =>
      format.source === source && String(format.id) === String(id)
    ) || null;
  }

  function currentSelectedFormat() {
    const select = document.getElementById('access-user-format');
    if (!select) return null;
    const [source, id] = String(select.value || '').split(':');
    return findFormat(source, id);
  }

  function preferredDefaultFormat() {
    const formats = supportedCardFormats();
    return formats.find(format => format.value === 'H10302') || formats[0] || cardFormats()[0] || null;
  }

  function formatLabel(format) {
    return format?.label || format?.name || format?.value || 'Unknown format';
  }

  function capabilityText(format) {
    const payload = format?.payload || {};
    const flags = [];
    if (payload.is_reverse_card_format) flags.push('reverse card');
    if (payload.is_reversal_of_bytes) flags.push('reverse bytes');
    if (payload.total_even_parity_bits || payload.total_odd_parity_bits) flags.push('parity');
    return flags.length > 0 ? flags.join(', ') : 'standard';
  }

  function byMostRecent(a, b) {
    const aTime = Date.parse(a?.updatedAt || a?.createdAt || 0) || 0;
    const bTime = Date.parse(b?.updatedAt || b?.createdAt || 0) || 0;
    return bTime - aTime;
  }

  function storedLockLabels(lockIds, defaultLabel = '-') {
    const ids = Array.isArray(lockIds) ? lockIds : [];
    if (ids.length === 0) return defaultLabel;

    const liveById = new Map();
    liveLocks().forEach(lock => {
      if (!liveById.has(lock.linkId)) {
        liveById.set(lock.linkId, lock);
      }
    });

    return ids.map(linkId => {
      const live = liveById.get(linkId);
      return live?.deviceName || linkId;
    }).join(', ');
  }

  function shortRecordId(id) {
    const value = String(id || '').trim();
    if (!value) return '-';
    return value.length <= 10 ? value : value.slice(-8);
  }

  function recordMeta(record) {
    const stamp = record?.updatedAt || record?.createdAt || null;
    const timeLabel = stamp ? fmtTimestamp(stamp) : '-';
    return `ID ${shortRecordId(record?.id)} | Updated ${timeLabel}`;
  }

  function formatCompatibility(format, values = {}) {
    if (!format) return { ok: false, reason: 'Select a card format first' };
    if (isUnsupportedFormat(format)) {
      return { ok: false, reason: `${formatLabel(format)} uses features that are not supported in this POC` };
    }

    const payload = format.payload || {};
    const cardNumber = String(values.cardNumber ?? '').trim();
    const facilityCode = String(values.facilityCode ?? '').trim();
    const issueCode = String(values.issueCode ?? '').trim();

    if (!cardNumber) {
      return { ok: true, reason: 'Enter a card number to validate the selected format' };
    }
    if (!/^\d+$/.test(cardNumber)) {
      return { ok: false, reason: 'Card number must contain digits only' };
    }

    if (payload.min_number_of_digits > 0 && cardNumber.length < payload.min_number_of_digits) {
      return { ok: false, reason: `Card number must be at least ${payload.min_number_of_digits} digits` };
    }
    if (payload.max_number_of_digits > 0 && cardNumber.length > payload.max_number_of_digits) {
      return { ok: false, reason: `Card number must be at most ${payload.max_number_of_digits} digits` };
    }

    const cardBits = Number(payload.total_cardholder_id_bits || 0);
    const offset = Number(payload.offset || 0);
    const cardValue = parseDecimalBigInt(cardNumber);
    if (cardValue === null) {
      return { ok: false, reason: 'Card number must contain digits only' };
    }
    if (cardValue + BigInt(offset) > maxValueForBits(cardBits)) {
      return {
        ok: false,
        reason: `Card number ${cardNumber} does not fit ${format.value || format.name} (${cardBits} cardholder bits)`,
      };
    }

    if (format.fc) {
      if (!facilityCode) {
        return { ok: false, reason: `Facility code is required for ${format.value || format.name}` };
      }
      const facilityValue = parseDecimalBigInt(facilityCode);
      if (facilityValue === null) {
        return { ok: false, reason: 'Facility code must contain digits only' };
      }
      if (facilityValue < BigInt(format.fc.min) || facilityValue > BigInt(format.fc.max)) {
        return { ok: false, reason: `Facility code must be between ${format.fc.min} and ${format.fc.max}` };
      }
      const facilityBits = Number(payload.total_facility_code_bits || 0);
      if (facilityBits > 0 && facilityValue > maxValueForBits(facilityBits)) {
        return { ok: false, reason: `Facility code does not fit ${facilityBits} facility bits` };
      }
    } else if (facilityCode) {
      return { ok: false, reason: `${format.value || format.name} does not use a facility code` };
    }

    if (issueCode) {
      const issueValue = parseDecimalBigInt(issueCode);
      if (issueValue === null) {
        return { ok: false, reason: 'Issue code must contain digits only' };
      }
      const issueBits = Number(payload.total_issue_code_bits || 0);
      if (issueBits <= 0 && issueValue > 0n) {
        return { ok: false, reason: `${format.value || format.name} does not use an issue code` };
      }
      if (issueValue > maxValueForBits(issueBits)) {
        return { ok: false, reason: `Issue code does not fit ${issueBits} issue bits` };
      }
    }

    return { ok: true, reason: `${cardNumber} fits ${formatLabel(format)}` };
  }

  function chooseRecommendedFormat(values = {}, preferred = null) {
    const formats = supportedCardFormats();
    if (formats.length === 0) return null;

    if (preferred) {
      const match = formatCompatibility(preferred, values);
      if (match.ok) return preferred;
    }

    const noFacilityCode = !String(values.facilityCode ?? '').trim();
    const ordered = [];
    const h10302 = formats.find(format => format.value === 'H10302');
    if (h10302 && noFacilityCode) ordered.push(h10302);
    formats.forEach(format => {
      if (!ordered.includes(format)) ordered.push(format);
    });

    if (!String(values.cardNumber ?? '').trim()) {
      return ordered[0] || preferredDefaultFormat();
    }

    return ordered.find(format => formatCompatibility(format, values).ok) || ordered[0];
  }

  function setSelectedFormat(source, id) {
    const select = document.getElementById('access-user-format');
    if (!select) return;
    const nextValue = formatRefValue(source, id);
    if (Array.from(select.options).some(option => option.value === nextValue)) {
      select.value = nextValue;
    }
  }

  function setFormError(kind, message) {
    const el = document.getElementById(`access-${kind}-error`);
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || '';
  }

  function clearFormError(kind) {
    setFormError(kind, '');
  }

  function userFormValues() {
    return {
      cardNumber: document.getElementById('access-user-card')?.value || '',
      facilityCode: document.getElementById('access-user-facility')?.value || '',
      issueCode: document.getElementById('access-user-issue')?.value || '',
    };
  }

  function updateFacilityFieldVisibility(format) {
    const wrap = document.getElementById('access-user-fc-wrap');
    if (!wrap) return;
    wrap.hidden = !format?.fc;
  }

  function refreshUserFormatHint(autoPick = false) {
    const hint = document.getElementById('access-user-format-hint');
    const current = currentSelectedFormat();
    const values = userFormValues();
    let active = current;

    if (autoPick) {
      const recommended = chooseRecommendedFormat(values, current);
      if (recommended && (!current || !formatCompatibility(current, values).ok)) {
        setSelectedFormat(recommended.source, recommended.id);
        active = recommended;
      }
    }

    updateFacilityFieldVisibility(active);

    if (!hint) return;
    const compatibility = formatCompatibility(active, values);
    const recommended = chooseRecommendedFormat(values, active);

    hint.className = 'form-helper';
    if (!String(values.cardNumber || '').trim()) {
      const fallback = preferredDefaultFormat();
      hint.textContent = fallback
        ? `Tip: for a raw card number with no facility code, ${formatLabel(fallback)} is the safest preset.`
        : 'Select a format to validate the card number.';
      return;
    }

    if (compatibility.ok) {
      hint.classList.add('success');
      hint.textContent = `Ready: ${compatibility.reason}.`;
      return;
    }

    hint.classList.add('warn');
    if (recommended && formatRefValue(recommended.source, recommended.id) !== formatRefValue(active?.source, active?.id)) {
      hint.textContent = `${compatibility.reason}. Recommended: ${formatLabel(recommended)}.`;
    } else {
      hint.textContent = compatibility.reason;
    }
  }

  function toggleFormatFacilityInputs() {
    const suppress = document.getElementById('access-format-suppress-fc')?.checked;
    const minField = document.getElementById('access-format-fc-min');
    const maxField = document.getElementById('access-format-fc-max');
    if (!minField || !maxField) return;
    minField.disabled = !!suppress;
    maxField.disabled = !!suppress;
    if (suppress) {
      minField.value = '';
      maxField.value = '';
    }
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || `${res.status}`);
    return data;
  }

  async function refreshState(preserveSelection = true) {
    const prevLinkId = accessState.selectedLockId;
    const prevSn = accessState.selectedGatewaySn;
    const data = await api('/api/access/state');
    accessState.users = data.users || [];
    accessState.schedules = data.schedules || [];
    accessState.builtInCardFormats = data.builtInCardFormats || [];
    accessState.customCardFormats = data.customCardFormats || [];
    accessState.loaded = true;

    if (preserveSelection && prevLinkId && prevSn) {
      accessState.selectedLockId = prevLinkId;
      accessState.selectedGatewaySn = prevSn;
    }

    ensureSelection();
    await Promise.all([refreshPreview(), refreshLockSettings()]);
    renderAll();
  }

  async function refreshPreview() {
    const lock = selectedLock();
    if (!lock) {
      accessState.preview = null;
      return;
    }
    try {
      const data = await api(`/api/access/preview/${encodeURIComponent(lock.linkId)}?gateway_sn=${encodeURIComponent(lock.sn)}`);
      accessState.preview = data.preview;
    } catch (err) {
      accessState.preview = { error: err.message };
    }
  }

  async function refreshLockSettings() {
    const lock = selectedLock();
    accessState.lockSettingsRequestToken += 1;
    const token = accessState.lockSettingsRequestToken;

    if (!lock) {
      accessState.lockSettingsValues = cloneLockSettingsValues();
      accessState.lockSettingsBaseline = cloneLockSettingsValues();
      accessState.lockSettingsSupported = {};
      accessState.lockSettingsFetchedAt = null;
      accessState.lockSettingsError = '';
      accessState.lockSettingsLoading = false;
      accessState.lockSettingsSaving = false;
      accessState.lockSettingsLockKey = null;
      return;
    }

    accessState.lockSettingsLoading = true;
    accessState.lockSettingsError = '';
    accessState.lockSettingsLockKey = lockKey(lock);
    expandLockSettingsSections();
    renderLockSettings();

    try {
      const data = await api(`/api/access/lock-settings/${encodeURIComponent(lock.linkId)}?gateway_sn=${encodeURIComponent(lock.sn)}`);
      if (token !== accessState.lockSettingsRequestToken || accessState.lockSettingsLockKey !== lockKey(lock)) return;
      setLockSettingsState(data.settings || {});
    } catch (err) {
      if (token !== accessState.lockSettingsRequestToken || accessState.lockSettingsLockKey !== lockKey(lock)) return;
      accessState.lockSettingsError = err.message;
      accessState.lockSettingsValues = cloneLockSettingsValues();
      accessState.lockSettingsBaseline = cloneLockSettingsValues();
      accessState.lockSettingsSupported = {};
      accessState.lockSettingsFetchedAt = null;
    } finally {
      if (token === accessState.lockSettingsRequestToken && accessState.lockSettingsLockKey === lockKey(lock)) {
        accessState.lockSettingsLoading = false;
        renderLockSettings();
      }
    }
  }

  function switchView(mode) {
    const views = {
      live: document.getElementById('live-view'),
      access: document.getElementById('access-view'),
      playground: document.getElementById('playground-view'),
    };
    const buttons = {
      live: document.getElementById('mode-live'),
      access: document.getElementById('mode-access'),
      playground: document.getElementById('mode-playground'),
    };
    for (const [key, el] of Object.entries(views)) {
      if (el) {
        const isActive = key === mode;
        el.hidden = !isActive;
        el.setAttribute('aria-hidden', String(!isActive));
      }
    }
    for (const [key, btn] of Object.entries(buttons)) {
      if (btn) {
        const isActive = key === mode;
        btn.classList.toggle('mode-btn-active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
        btn.setAttribute('tabindex', isActive ? '0' : '-1');
      }
    }
    if (mode === 'access' && !accessState.loaded) refreshState();
    if (mode === 'access') renderAll();
    if (mode === 'playground' && window.playgroundUI) window.playgroundUI.onActivated();
  }

  function renderLocks() {
    const el = document.getElementById('access-lock-list');
    const locks = liveLocks();
    document.getElementById('access-lock-count').textContent = `${locks.length} locks`;
    if (locks.length === 0) {
      el.innerHTML = '<div class="access-empty">No connected locks. Connect a gateway to manage access databases.</div>';
      return;
    }

    el.innerHTML = locks.map(lock => {
      const selected = lock.linkId === accessState.selectedLockId && lock.sn === accessState.selectedGatewaySn;
      const push = pushStateFor(lock.linkId);
      const syncStatus = push ? String(push.status || 'unknown') : 'idle';
      return `
        <button class="access-lock-item ${selected ? 'selected' : ''}" onclick="window.accessUI.selectLock('${esc(lock.linkId)}','${esc(lock.sn)}')">
          <div class="access-lock-title">${esc(lock.deviceName || lock.linkId)}</div>
          <div class="access-lock-meta">${esc(lock.linkId)}</div>
          <div class="access-lock-status">${esc(lock.lockState || '?')} · ${esc(syncStatus)}</div>
        </button>
      `;
    }).join('');
  }

  function renderUsers() {
    const tbody = document.getElementById('access-users-body');
    document.getElementById('access-user-count').textContent = `${accessState.users.length} credentials`;
    if (accessState.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="access-table-empty">No credentials added yet.</td></tr>';
      return;
    }

    tbody.innerHTML = [...accessState.users].sort(byMostRecent).map(user => {
      const scheduleNames = accessState.schedules
        .filter(schedule => user.scheduleIds?.includes(schedule.id))
        .map(schedule => schedule.name)
        .join(', ') || '24x7 Default';
      const lockNames = storedLockLabels(user.lockIds);
      return `
        <tr>
          <td>
            <div class="record-title">${esc(user.name || '-')}</div>
            <div class="record-meta">${esc(recordMeta(user))}</div>
          </td>
          <td>${esc(String(user.usrID))}</td>
          <td>${esc(user.maskedCardNumber || user.cardNumber || '-')}</td>
          <td>${esc(user.formatLabel || user.formatValue || '-')}</td>
          <td>${esc(scheduleNames)}</td>
          <td>${esc(lockNames)}</td>
          <td class="access-actions-cell">
            <button class="mini-btn" type="button" onclick="window.accessUI.openUserModal('${esc(user.id)}')">Edit</button>
            <button class="mini-btn danger" type="button" onclick="window.accessUI.deleteUser('${esc(user.id)}')">Delete</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderSchedules() {
    const tbody = document.getElementById('access-schedules-body');
    document.getElementById('access-schedule-count').textContent = `${accessState.schedules.length} schedules`;
    if (accessState.schedules.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="access-table-empty">No schedules defined.</td></tr>';
      return;
    }

    tbody.innerHTML = [...accessState.schedules].sort((a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return byMostRecent(a, b);
    }).map(schedule => {
      const lockNames = schedule.isDefault ? 'All payloads' : storedLockLabels(schedule.lockIds);
      return `
        <tr>
          <td>
            <div class="record-title">${esc(schedule.name)} ${schedule.isDefault ? '<span class="pill-default">Required</span>' : ''}</div>
            <div class="record-meta">${esc(recordMeta(schedule))}</div>
          </td>
          <td>${esc(schedule.days.join(' '))}</td>
          <td>${String(schedule.strtHr).padStart(2, '0')}:${String(schedule.strtMn).padStart(2, '0')}</td>
          <td>${esc(String(schedule.lngth))} min</td>
          <td>${esc(lockNames)}</td>
          <td class="access-actions-cell">
            ${schedule.isDefault ? '' : `<button class="mini-btn" type="button" onclick="window.accessUI.openScheduleModal('${esc(schedule.id)}')">Edit</button>`}
            ${schedule.isDefault ? '' : `<button class="mini-btn danger" type="button" onclick="window.accessUI.deleteSchedule('${esc(schedule.id)}')">Delete</button>`}
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderFormats() {
    const tbody = document.getElementById('access-formats-body');
    const formats = [
      ...accessState.customCardFormats.map(format => ({ ...format, source: 'Custom', sourceKey: 'custom', stableId: format.id })),
      ...accessState.builtInCardFormats.map(format => ({ ...format, source: 'Built in', sourceKey: 'builtin', stableId: format.value })),
    ];

    document.getElementById('access-format-count').textContent = `${accessState.customCardFormats.length} custom`;
    if (formats.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="access-table-empty">No card formats available.</td></tr>';
      return;
    }

    tbody.innerHTML = formats.map(format => {
      const unsupported = isUnsupportedFormat(format);
      const facilitySummary = format.fc ? `${format.fc.min} - ${format.fc.max}` : 'Not required';
      const sourceClass = format.sourceKey === 'custom' ? 'custom' : 'builtin';
      return `
        <tr>
          <td><span class="format-source-pill ${sourceClass}">${esc(format.source)}</span></td>
          <td>
            <div class="format-row-title">${esc(formatLabel(format))}</div>
            <div class="format-row-meta">${esc(format.value || format.id || '')}</div>
          </td>
          <td>${esc(String(format.payload?.total_card_bits || 0))}</td>
          <td>${esc(facilitySummary)}</td>
          <td>${unsupported ? '<span class="format-compat warn">Unsupported in POC</span>' : esc(capabilityText(format))}</td>
          <td class="access-actions-cell">
            <button class="mini-btn" type="button" onclick="window.accessUI.openUserModal(null, '${esc(format.sourceKey)}', '${esc(format.stableId)}')" ${unsupported ? 'disabled' : ''}>Use</button>
            ${format.sourceKey === 'custom' ? `<button class="mini-btn" type="button" onclick="window.accessUI.openFormatModal('${esc(format.id)}')">Edit</button>` : ''}
            ${format.sourceKey === 'custom' ? `<button class="mini-btn danger" type="button" onclick="window.accessUI.deleteFormat('${esc(format.id)}')">Delete</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderPreview() {
    const title = document.getElementById('access-preview-title');
    const summary = document.getElementById('access-preview-summary');
    const pre = document.getElementById('access-preview-json');
    const lock = selectedLock();
    if (!lock) {
      title.textContent = 'No lock selected';
      summary.textContent = 'Select a lock to build a payload preview.';
      pre.textContent = '';
      return;
    }

    title.textContent = `${lock.deviceName || lock.linkId} (${lock.linkId})`;
    if (!accessState.preview) {
      summary.textContent = 'Loading preview...';
      pre.textContent = '';
      return;
    }
    if (accessState.preview.error) {
      summary.textContent = accessState.preview.error;
      pre.textContent = '';
      return;
    }

    const preview = accessState.preview;
    const summaryData = preview.summary || {};
    const scheduleMappings = (preview.scheduleMappings || [])
      .map(item => `${item.wireIndex}:${item.name}`)
      .join(', ');
    summary.innerHTML = `Users: ${summaryData.userCount || 0} | Schedules: ${summaryData.scheduleCount || 0} | Wire order: ${esc(scheduleMappings || 'none')}
      <button class="mini-btn" type="button" style="margin-left:8px;font-size:10px;padding:2px 8px;vertical-align:middle" onclick="window.accessUI.viewPreviewPayload()">&#x1F50D; View Full</button>`;
    pre.textContent = JSON.stringify(preview.payload, null, 2);
  }

  function lockSettingsPayload() {
    const payload = {};
    Object.entries(accessState.lockSettingsSupported || {}).forEach(([key, supported]) => {
      if (!supported) return;
      payload[key] = accessState.lockSettingsValues[key];
    });
    return payload;
  }

  function renderLockSettings() {
    const boxes = Array.from(document.querySelectorAll('[data-lock-settings-host="true"]'));
    if (boxes.length === 0) return;
    const setHtml = (html) => boxes.forEach(box => { box.innerHTML = html; });

    try {
      const lock = selectedLock();
      if (!lock) {
        setHtml('<div class="access-empty">Select a target lock to read and update reader settings.</div>');
        return;
      }

      if (accessState.lockSettingsLoading) {
        setHtml('<div class="access-empty">Loading current lock settings...</div>');
        return;
      }

      if (accessState.lockSettingsError) {
        setHtml(`
          <div class="lock-settings-banner error">${esc(accessState.lockSettingsError)}</div>
          <div class="lock-settings-toolbar">
            <button class="mini-btn" type="button" onclick="window.accessUI.refreshLockSettings()">Refresh From Lock</button>
          </div>
        `);
        return;
      }

      const dirty = hasLockSettingsChanges();
      const fetchedAt = accessState.lockSettingsFetchedAt ? fmtTimestamp(accessState.lockSettingsFetchedAt) : 'Not fetched yet';
      const supportedCount = Object.values(accessState.lockSettingsSupported || {}).filter(Boolean).length;
      if (supportedCount === 0) {
        setHtml(`
          <div class="lock-settings-banner warn">No lock settings were returned for this device yet.</div>
          <div class="lock-settings-toolbar">
            <div class="lock-settings-meta">
              <div class="lock-settings-lock">${esc(lock.deviceName || lock.linkId)} <span>${esc(lock.linkId)}</span></div>
              <div class="lock-settings-fetched">Fetched ${esc(fetchedAt)}</div>
            </div>
            <div class="lock-settings-actions">
              <button class="mini-btn" type="button" onclick="window.accessUI.refreshLockSettings()">Refresh From Lock</button>
            </div>
          </div>
        `);
        return;
      }
      const groups = LOCK_SETTING_GROUPS.map(group => `
        <div class="lock-settings-group">
          <div class="lock-settings-group-title">${esc(group.title)}</div>
          <div class="lock-settings-group-helper">${esc(group.helper)}</div>
          ${group.items.map(item => {
            const supported = !!accessState.lockSettingsSupported[item.key];
            if (item.type === 'select') {
              const options = item.options.map(option => `
                <option value="${esc(option.value)}" ${String(accessState.lockSettingsValues[item.key]) === String(option.value) ? 'selected' : ''}>
                  ${esc(option.label)}
                </option>
              `).join('');

              return `
                <div class="lock-setting-row ${supported ? '' : 'disabled'}">
                  <div class="lock-setting-copy">
                    <div class="lock-setting-label">${esc(item.label)}</div>
                    <div class="lock-setting-note">${esc(item.note)}</div>
                  </div>
                  <div class="lock-setting-control">
                    <select class="lock-setting-select" ${supported ? '' : 'disabled'} onchange="window.accessUI.setGeProxFormat(this.value)">
                      ${options}
                    </select>
                    ${supported ? '' : '<div class="lock-setting-support">Unavailable on this lock</div>'}
                  </div>
                </div>
              `;
            }

            return `
              <div class="lock-setting-row ${supported ? '' : 'disabled'}">
                <div class="lock-setting-copy">
                  <div class="lock-setting-label">${esc(item.label)}</div>
                  <div class="lock-setting-note">${esc(item.note)}</div>
                </div>
                <div class="lock-setting-control">
                  <label class="lock-setting-toggle">
                    <input
                      type="checkbox"
                      ${accessState.lockSettingsValues[item.key] ? 'checked' : ''}
                      ${supported ? '' : 'disabled'}
                      onchange="window.accessUI.setLockSetting('${esc(item.key)}', this.checked)"
                    >
                    <span>${accessState.lockSettingsValues[item.key] ? 'Enabled' : 'Disabled'}</span>
                  </label>
                  ${supported ? '' : '<div class="lock-setting-support">Unavailable on this lock</div>'}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `).join('');

      setHtml(`
        <div class="lock-settings-toolbar">
          <div class="lock-settings-meta">
            <div class="lock-settings-lock">${esc(lock.deviceName || lock.linkId)} <span>${esc(lock.linkId)}</span></div>
            <div class="lock-settings-fetched">Fetched ${esc(fetchedAt)}</div>
          </div>
          <div class="lock-settings-actions">
            <button class="mini-btn" type="button" onclick="window.accessUI.refreshLockSettings()">Refresh From Lock</button>
            <button class="mini-btn lock-settings-primary" type="button" onclick="window.accessUI.saveLockSettings()" ${dirty && !accessState.lockSettingsSaving ? '' : 'disabled'}>
              ${accessState.lockSettingsSaving ? 'Saving...' : dirty ? 'Save Changes' : 'No Changes'}
            </button>
          </div>
        </div>
        ${dirty ? '<div class="lock-settings-banner warn">Unsaved reader-setting changes for this lock.</div>' : '<div class="lock-settings-banner success">Reader settings match the last values fetched from the lock.</div>'}
        ${groups}
      `);
    } catch (err) {
      console.error('Lock settings render failed', err);
      setHtml(`
        <div class="lock-settings-banner error">Lock settings could not be rendered: ${esc(err.message || 'Unknown error')}</div>
        <div class="lock-settings-toolbar">
          <button class="mini-btn" type="button" onclick="window.accessUI.refreshLockSettings()">Refresh From Lock</button>
        </div>
      `);
    }
  }

  function renderStatus() {
    const box = document.getElementById('access-transfer-status');
    const lock = selectedLock();
    if (!lock) {
      box.innerHTML = '<div class="access-empty">No lock selected.</div>';
      return;
    }

    const push = pushStateFor(lock.linkId);
    if (!push) {
      box.innerHTML = '<div class="access-empty">Changes sync to this lock automatically after save.</div>';
      return;
    }

    const statusColor = push.status === 'failed' ? 'var(--red)' : push.status === 'completed' ? 'var(--green)' : push.status === 'in-progress' ? 'var(--yellow)' : 'var(--text)';

    // Build request payload section
    const reqPayload = push.requestPayload || push.pushResult?.requestPayload;
    const reqJson = reqPayload ? JSON.stringify(reqPayload, null, 2) : null;
    const reqSection = reqJson
      ? `<div class="status-detail-section">
          <div class="status-detail-label">Request Payload (PUT /edgeDevices/${esc(lock.linkId)}/database)
            <button class="mini-btn" type="button" style="margin-left:6px;font-size:9px;padding:1px 6px" onclick="window.accessUI.viewStatusDetail('request')">View Full</button>
          </div>
          <pre class="status-detail-json" style="max-height:150px">${esc(reqJson)}</pre>
        </div>`
      : '';

    // Build response section
    const rawResp = push.rawPushResponse || push.pushResult?.initialResponse;
    const respJson = rawResp ? (typeof rawResp === 'string' ? rawResp : JSON.stringify(rawResp, null, 2)) : null;
    const respSection = respJson
      ? `<div class="status-detail-section">
          <div class="status-detail-label">Gateway Response (HTTP ${esc(String(push.responseStatus || push.pushResult?.status?.responseStatus || '?'))})
            <button class="mini-btn" type="button" style="margin-left:6px;font-size:9px;padding:1px 6px" onclick="window.accessUI.viewStatusDetail('response')">View Full</button>
          </div>
          <pre class="status-detail-json" style="max-height:120px">${esc(respJson)}</pre>
        </div>`
      : '';

    // Build error section
    const errorSection = push.error
      ? `<div class="status-detail-section">
          <div class="status-detail-label" style="color:var(--red)">Error</div>
          <pre class="status-detail-json" style="border-color:rgba(239,68,68,.3)">${esc(push.error)}</pre>
        </div>`
      : '';

    // Raw status from polling (dbDownloadStatus)
    const rawStatus = push.rawStatus;
    const rawStatusJson = rawStatus ? (typeof rawStatus === 'string' ? rawStatus : JSON.stringify(rawStatus, null, 2)) : null;
    const rawStatusSection = rawStatusJson
      ? `<div class="status-detail-section">
          <div class="status-detail-label">Lock Download Status (dbDownloadStatus)
            <button class="mini-btn" type="button" style="margin-left:6px;font-size:9px;padding:1px 6px" onclick="window.accessUI.viewStatusDetail('liveStatus')">View Full</button>
          </div>
          <pre class="status-detail-json" style="max-height:120px">${esc(rawStatusJson)}</pre>
        </div>`
      : '';

    box.innerHTML = `
      <div class="status-line"><span>Status</span><strong style="color:${statusColor}">${esc(push.status || 'unknown')}</strong></div>
      <div class="status-line"><span>Gateway</span><strong>${esc(push.sn || lock.sn)}</strong></div>
      <div class="status-line"><span>Progress</span><strong>${push.progress !== null && push.progress !== undefined ? `${esc(String(push.progress))}%` : '-'}</strong></div>
      <div class="status-line"><span>Updated</span><strong>${esc(push.updatedAt || '-')}</strong></div>
      ${errorSection}
      ${reqSection}
      ${respSection}
      ${rawStatusSection}
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="mini-btn" type="button" style="font-size:10px;flex:1" onclick="window.accessUI.refreshStatus()">&#x1F504; Refresh Status</button>
        <button class="mini-btn" type="button" style="font-size:10px;flex:1" onclick="window.accessUI.pullDatabase()">&#x1F4E5; Pull Lock DB</button>
      </div>
    `;
  }


  function renderAll() {
    ensureSelection();
    renderLocks();
    renderUsers();
    renderSchedules();
    renderFormats();
    renderLockSettings();
    renderPreview();
    renderStatus();
  }

  function fillLockChecklist(containerId, selectedIds) {
    const el = document.getElementById(containerId);
    const selected = new Set(selectedIds || []);
    const locks = liveLocks();
    el.innerHTML = locks.length === 0
      ? '<div class="checkbox-empty">No locks available.</div>'
      : locks.map(lock => `
          <label class="check-row">
            <input type="checkbox" value="${esc(lock.linkId)}" ${selected.has(lock.linkId) ? 'checked' : ''}>
            <span>${esc(lock.deviceName || lock.linkId)} <small>${esc(lock.linkId)}</small></span>
          </label>
        `).join('');
  }

  function fillScheduleChecklist(containerId, selectedIds) {
    const el = document.getElementById(containerId);
    const selected = new Set(selectedIds || []);
    el.innerHTML = accessState.schedules.map(schedule => `
      <label class="check-row">
        <input type="checkbox" value="${esc(schedule.id)}" ${selected.has(schedule.id) ? 'checked' : ''}>
        <span>${esc(schedule.name)} ${schedule.isDefault ? '<small>(required default)</small>' : ''}</span>
      </label>
    `).join('');
  }

  function fillFormatSelect(source, id) {
    const select = document.getElementById('access-user-format');
    const builtIns = accessState.builtInCardFormats.map(format => ({ ...format, source: 'builtin', id: format.value }));
    const customs = accessState.customCardFormats.map(format => ({ ...format, source: 'custom', id: format.id }));

    const renderOptions = (formats) => formats.map(format => {
      const unsupported = isUnsupportedFormat(format);
      const selected = format.source === source && String(format.id) === String(id);
      const label = unsupported ? `${formatLabel(format)} (Unsupported in POC)` : formatLabel(format);
      return `<option value="${esc(formatRefValue(format.source, format.id))}" ${selected ? 'selected' : ''} ${unsupported ? 'disabled' : ''}>${esc(label)}</option>`;
    }).join('');

    const groups = [];
    if (builtIns.length > 0) {
      groups.push(`<optgroup label="Built in formats">${renderOptions(builtIns)}</optgroup>`);
    }
    if (customs.length > 0) {
      groups.push(`<optgroup label="Custom formats">${renderOptions(customs)}</optgroup>`);
    }
    select.innerHTML = groups.join('');

    const fallback = preferredDefaultFormat();
    const desired = findFormat(source, id) || fallback;
    if (desired) {
      setSelectedFormat(desired.source, desired.id);
    }
  }

  function checkedValues(containerId) {
    return Array.from(document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)).map(input => input.value);
  }

  function uniqueLockIds(values) {
    return [...new Set((values || []).filter(Boolean).map(value => String(value)))];
  }

  function affectedLocksForUser(existingUser, nextLockIds) {
    return uniqueLockIds([
      ...(existingUser?.lockIds || []),
      ...(nextLockIds || []),
    ]);
  }

  function affectedLocksForSchedule(existingSchedule, nextLockIds, scheduleId) {
    const userLinkedLocks = accessState.users
      .filter(user => Array.isArray(user.scheduleIds) && user.scheduleIds.includes(scheduleId))
      .flatMap(user => user.lockIds || []);

    return uniqueLockIds([
      ...(existingSchedule?.lockIds || []),
      ...(nextLockIds || []),
      ...userLinkedLocks,
    ]);
  }

  function affectedLocksForFormat(formatId) {
    return uniqueLockIds(
      accessState.users
        .filter(user => user.formatSource === 'custom' && String(user.formatId) === String(formatId))
        .flatMap(user => user.lockIds || [])
    );
  }

  async function autoPushLocks(lockIds, actionLabel) {
    const targetIds = uniqueLockIds(lockIds);
    if (targetIds.length === 0) {
      showToast(`${actionLabel} saved. No lock sync was needed.`, 'success');
      return;
    }

    const liveById = new Map();
    liveLocks().forEach(lock => {
      if (!liveById.has(lock.linkId)) liveById.set(lock.linkId, lock);
    });

    const pushable = targetIds.map(linkId => liveById.get(linkId)).filter(Boolean);
    const skipped = targetIds.filter(linkId => !liveById.has(linkId));

    if (pushable.length === 0) {
      showToast(`${actionLabel} saved, but sync was skipped because the assigned locks are not connected.`, 'warn', 5000);
      return;
    }

    const results = await Promise.allSettled(pushable.map(lock =>
      api(`/api/access/push/${encodeURIComponent(lock.linkId)}`, {
        method: 'POST',
        body: JSON.stringify({ gateway_sn: lock.sn }),
      }).then(() => lock)
    ));

    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length > 0) {
      const firstError = failed[0].reason?.message || 'Unknown push failure';
      showToast(`${actionLabel} saved, but ${failed.length} lock sync(s) failed. ${firstError}`, 'error', 6000);
      return;
    }

    const skippedSuffix = skipped.length > 0
      ? ` ${skipped.length} disconnected lock(s) were skipped.`
      : '';
    showToast(`${actionLabel} saved and syncing ${pushable.length} lock(s).${skippedSuffix}`, skipped.length > 0 ? 'warn' : 'success', 5000);
  }

  function openModal(id) {
    document.getElementById(id).classList.add('show');
  }

  function closeModal(id) {
    document.getElementById(id).classList.remove('show');
  }

  function openUserModal(userId = null, presetSource = null, presetId = null) {
    clearFormError('user');
    const user = accessState.users.find(item => item.id === userId) || null;
    accessState.userFormatTouched = !!user;

    document.getElementById('access-user-id').value = user?.id || '';
    document.getElementById('access-user-name').value = user?.name || '';
    document.getElementById('access-user-usrid').value = user?.usrID || '';
    document.getElementById('access-user-card').value = user?.cardNumber || '';
    document.getElementById('access-user-facility').value = user?.facilityCode ?? '';
    document.getElementById('access-user-issue').value = user?.issueCode ?? '';

    const defaultFormat = preferredDefaultFormat();
    fillFormatSelect(
      presetSource || user?.formatSource || defaultFormat?.source || 'builtin',
      presetId || user?.formatId || defaultFormat?.id || accessState.builtInCardFormats[0]?.value
    );
    fillScheduleChecklist('access-user-schedules', user?.scheduleIds || [accessState.schedules[0]?.id]);
    fillLockChecklist('access-user-locks', user?.lockIds || []);
    refreshUserFormatHint(true);
    openModal('access-user-modal');
  }

  async function addUserFromSwipe(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);

      // Ensure access state is loaded (card formats, locks, schedules)
      if (!accessState.loaded) await refreshState();

      // Switch to Access Database tab so the modal renders in the right context
      switchView('access');

      // If we have an explicit format from decoded credential, use it.
      // Otherwise match the card bit count to the best built-in format.
      let presetSource = data.formatSource || null;
      let presetId = data.formatId || null;
      if (!presetSource && data.cardBitCount) {
        const bitMatch = cardFormats().find(f =>
          f.payload && Number(f.payload.total_card_bits) === Number(data.cardBitCount)
        );
        if (bitMatch) {
          presetSource = bitMatch.source;
          presetId = bitMatch.source === 'custom' ? bitMatch.id : bitMatch.value;
        }
      }

      openUserModal(null, presetSource, presetId);
      document.getElementById('access-user-card').value = data.cardNumber || '';
      document.getElementById('access-user-facility').value = data.facilityCode || '';
      if (data.linkId) {
        const cb = document.querySelector(`#access-user-locks input[value="${data.linkId}"]`);
        if (cb) cb.checked = true;
      }
      refreshUserFormatHint(true);
    } catch (err) {
      showToast('Could not pre-fill user from swipe data', 'error');
    }
  }

  function openScheduleModal(scheduleId = null) {
    clearFormError('schedule');
    const schedule = accessState.schedules.find(item => item.id === scheduleId) || null;
    document.getElementById('access-schedule-id').value = schedule?.id || '';
    document.getElementById('access-schedule-name').value = schedule?.name || '';
    document.getElementById('access-schedule-description').value = schedule?.description || '';
    document.getElementById('access-schedule-hour').value = schedule?.strtHr ?? 0;
    document.getElementById('access-schedule-minute').value = schedule?.strtMn ?? 0;
    document.getElementById('access-schedule-length').value = schedule?.lngth ?? 60;
    document.querySelectorAll('input[name="access-schedule-day"]').forEach(input => {
      input.checked = schedule ? schedule.days.includes(input.value) : false;
    });
    fillLockChecklist('access-schedule-locks', schedule?.lockIds || []);
    openModal('access-schedule-modal');
  }

  function openFormatModal(formatId = null) {
    clearFormError('format');
    const format = accessState.customCardFormats.find(item => item.id === formatId) || null;
    document.getElementById('access-format-id').value = format?.id || '';
    document.getElementById('access-format-name').value = format?.name || '';
    document.getElementById('access-format-description').value = format?.description || '';
    document.getElementById('access-format-total-bits').value = format?.payload?.total_card_bits ?? 32;
    document.getElementById('access-format-offset').value = format?.payload?.offset ?? 0;
    document.getElementById('access-format-fc-bits').value = format?.payload?.total_facility_code_bits ?? 0;
    document.getElementById('access-format-fc-start').value = format?.payload?.facility_code_start_bit ?? 0;
    document.getElementById('access-format-issue-bits').value = format?.payload?.total_issue_code_bits ?? 0;
    document.getElementById('access-format-issue-start').value = format?.payload?.issue_code_start_bit ?? 0;
    document.getElementById('access-format-card-bits').value = format?.payload?.total_cardholder_id_bits ?? 32;
    document.getElementById('access-format-card-start').value = format?.payload?.cardholder_id_start_bit ?? 0;
    document.getElementById('access-format-odd-bits').value = format?.payload?.total_odd_parity_bits ?? 0;
    document.getElementById('access-format-odd-start').value = format?.payload?.odd_parity_start_bit ?? 0;
    document.getElementById('access-format-even-bits').value = format?.payload?.total_even_parity_bits ?? 0;
    document.getElementById('access-format-even-start').value = format?.payload?.even_parity_start_bit ?? 0;
    document.getElementById('access-format-fc-min').value = format?.fc?.min ?? '';
    document.getElementById('access-format-fc-max').value = format?.fc?.max ?? '';
    document.getElementById('access-format-suppress-fc').checked = !format?.fc;
    document.getElementById('access-format-reverse-card').checked = !!format?.payload?.is_reverse_card_format;
    document.getElementById('access-format-reverse-bytes').checked = !!format?.payload?.is_reversal_of_bytes;
    toggleFormatFacilityInputs();
    openModal('access-format-modal');
  }

  async function saveUser(event) {
    event.preventDefault();
    clearFormError('user');
    const existingUser = accessState.users.find(item => item.id === document.getElementById('access-user-id').value) || null;
    const selectedLockIds = checkedValues('access-user-locks');
    const [formatSource, formatId] = document.getElementById('access-user-format').value.split(':');
    const format = findFormat(formatSource, formatId);
    const compatibility = formatCompatibility(format, userFormValues());
    if (!compatibility.ok) {
      setFormError('user', compatibility.reason);
      showToast(compatibility.reason, 'error');
      return;
    }

    try {
      await api('/api/access/users', {
        method: 'POST',
        body: JSON.stringify({
          id: document.getElementById('access-user-id').value || undefined,
          name: document.getElementById('access-user-name').value,
          usrID: document.getElementById('access-user-usrid').value,
          cardNumber: document.getElementById('access-user-card').value,
          facilityCode: document.getElementById('access-user-facility').value,
          issueCode: document.getElementById('access-user-issue').value,
          formatSource,
          formatId,
          scheduleIds: checkedValues('access-user-schedules'),
          lockIds: selectedLockIds,
        }),
      });
      closeModal('access-user-modal');
      await refreshState();
      await autoPushLocks(affectedLocksForUser(existingUser, selectedLockIds), 'Credential');
    } catch (err) {
      setFormError('user', err.message);
      showToast(err.message, 'error');
    }
  }

  async function saveSchedule(event) {
    event.preventDefault();
    clearFormError('schedule');
    const scheduleId = document.getElementById('access-schedule-id').value;
    const existingSchedule = accessState.schedules.find(item => item.id === scheduleId) || null;
    const selectedLockIds = checkedValues('access-schedule-locks');
    try {
      await api('/api/access/schedules', {
        method: 'POST',
        body: JSON.stringify({
          id: scheduleId || undefined,
          name: document.getElementById('access-schedule-name').value,
          description: document.getElementById('access-schedule-description').value,
          strtHr: document.getElementById('access-schedule-hour').value,
          strtMn: document.getElementById('access-schedule-minute').value,
          lngth: document.getElementById('access-schedule-length').value,
          days: Array.from(document.querySelectorAll('input[name="access-schedule-day"]:checked')).map(input => input.value),
          lockIds: selectedLockIds,
        }),
      });
      closeModal('access-schedule-modal');
      await refreshState();
      const newSchedule = accessState.schedules.find(item =>
        item.id === scheduleId ||
        (!scheduleId && item.name === document.getElementById('access-schedule-name').value)
      );
      const effectiveScheduleId = newSchedule?.id || scheduleId;
      await autoPushLocks(affectedLocksForSchedule(existingSchedule, selectedLockIds, effectiveScheduleId), 'Schedule');
    } catch (err) {
      setFormError('schedule', err.message);
      showToast(err.message, 'error');
    }
  }

  async function saveFormat(event) {
    event.preventDefault();
    clearFormError('format');
    const formatId = document.getElementById('access-format-id').value;
    const affectedLockIds = formatId ? affectedLocksForFormat(formatId) : [];

    try {
      const suppressFacilityCheck = document.getElementById('access-format-suppress-fc').checked;
      const formatName = document.getElementById('access-format-name').value;
      const formatDescription = document.getElementById('access-format-description').value;
      const userModalOpen = document.getElementById('access-user-modal').classList.contains('show');
      await api('/api/access/formats', {
        method: 'POST',
        body: JSON.stringify({
          id: document.getElementById('access-format-id').value || undefined,
          name: formatName,
          description: formatDescription,
          fc: suppressFacilityCheck ? null : (
            document.getElementById('access-format-fc-min').value !== '' || document.getElementById('access-format-fc-max').value !== ''
              ? {
                  min: document.getElementById('access-format-fc-min').value || 0,
                  max: document.getElementById('access-format-fc-max').value || 0,
                }
              : null
          ),
          payload: {
            format: 'WIEGAND',
            total_card_bits: document.getElementById('access-format-total-bits').value,
            offset: document.getElementById('access-format-offset').value,
            total_facility_code_bits: document.getElementById('access-format-fc-bits').value,
            facility_code_start_bit: document.getElementById('access-format-fc-start').value,
            total_issue_code_bits: document.getElementById('access-format-issue-bits').value,
            issue_code_start_bit: document.getElementById('access-format-issue-start').value,
            total_cardholder_id_bits: document.getElementById('access-format-card-bits').value,
            cardholder_id_start_bit: document.getElementById('access-format-card-start').value,
            total_odd_parity_bits: document.getElementById('access-format-odd-bits').value,
            odd_parity_start_bit: document.getElementById('access-format-odd-start').value,
            total_even_parity_bits: document.getElementById('access-format-even-bits').value,
            even_parity_start_bit: document.getElementById('access-format-even-start').value,
            card_format_code: document.getElementById('access-format-name').value,
            is_reverse_card_format: document.getElementById('access-format-reverse-card').checked,
            is_reversal_of_bytes: document.getElementById('access-format-reverse-bytes').checked,
          },
        }),
      });
      closeModal('access-format-modal');
      await refreshState(false);
      if (userModalOpen) {
        const matchingFormat = accessState.customCardFormats.find(format =>
          format.name === formatName &&
          String(format.description || '') === String(formatDescription || '')
        );
        if (matchingFormat) {
          fillFormatSelect('custom', matchingFormat.id);
          setSelectedFormat('custom', matchingFormat.id);
          accessState.userFormatTouched = true;
          refreshUserFormatHint(false);
        }
      }
      if (affectedLockIds.length > 0) {
        await autoPushLocks(affectedLockIds, 'Custom card format');
      } else {
        showToast('Custom card format saved', 'success');
      }
    } catch (err) {
      setFormError('format', err.message);
      showToast(err.message, 'error');
    }
  }

  async function pushSelectedLock() {
    const lock = selectedLock();
    if (!lock) return;
    try {
      const result = await api(`/api/access/push/${encodeURIComponent(lock.linkId)}`, {
        method: 'POST',
        body: JSON.stringify({ gateway_sn: lock.sn }),
      });
      // Store full push result for Transfer Status display
      if (result && lock.linkId) {
        state.databasePushStates[lock.linkId] = {
          ...(state.databasePushStates[lock.linkId] || {}),
          ...result.status,
          pushResult: result,
        };
      }
      showToast(`Database push started for ${lock.deviceName || lock.linkId}`, 'success');
      await refreshPreview();
      renderAll();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function cancelSelectedLock() {
    const lock = selectedLock();
    if (!lock) return;
    try {
      await api(`/api/access/push/${encodeURIComponent(lock.linkId)}?gateway_sn=${encodeURIComponent(lock.sn)}`, {
        method: 'DELETE',
      });
      showToast(`Database transfer cancelled for ${lock.deviceName || lock.linkId}`, 'warn');
      renderStatus();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function refreshStatus() {
    const lock = selectedLock();
    if (!lock) return;
    try {
      const status = await api(`/api/access/status/${encodeURIComponent(lock.linkId)}?gateway_sn=${encodeURIComponent(lock.sn)}`);
      state.databasePushStates[lock.linkId] = status;
      renderStatus();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function pullDatabase() {
    const lock = selectedLock();
    if (!lock) { showToast('Select a lock first', 'warn'); return; }
    try {
      showToast(`Checking lock status for ${lock.deviceName || lock.linkId}...`, 'info', 3000);
      const result = await api(`/api/access/status/${encodeURIComponent(lock.linkId)}?gateway_sn=${encodeURIComponent(lock.sn)}`);
      // Update local push state so status panel also refreshes
      if (result && lock.linkId) {
        state.databasePushStates[lock.linkId] = {
          ...(state.databasePushStates[lock.linkId] || {}),
          ...result,
        };
      }
      renderStatus();
      openJsonModal('Lock DB Status — ' + (lock.deviceName || lock.linkId), result);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function clearDatabase() {
    const lock = selectedLock();
    if (!lock) { showToast('Select a lock first', 'warn'); return; }
    if (!confirm(`This will DELETE ALL credentials from "${lock.deviceName || lock.linkId}". Continue?`)) return;
    try {
      showToast(`Clearing database on ${lock.deviceName || lock.linkId}...`, 'info', 3000);
      const result = await api(`/api/access/clear/${encodeURIComponent(lock.linkId)}`, {
        method: 'POST',
        body: JSON.stringify({ gateway_sn: lock.sn }),
      });
      if (result && lock.linkId) {
        state.databasePushStates[lock.linkId] = {
          ...(state.databasePushStates[lock.linkId] || {}),
          status: 'clearing',
          requestPayload: result.requestPayload,
          rawPushResponse: result.initialResponse,
          responseStatus: result.responseStatus,
        };
      }
      const msg = result.ok
        ? `Lock database clear started${result.removedLocalUsers ? ` (${result.removedLocalUsers} local user(s) removed)` : ''}`
        : 'Clear request sent (check status)';
      showToast(msg, result.ok ? 'success' : 'warn');
      await refreshState();
      renderStatus();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function openJsonModal(title, data) {
    const modal = document.getElementById('access-json-modal');
    document.getElementById('access-json-modal-title').textContent = title;
    document.getElementById('access-json-modal-body').textContent =
      typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    modal.classList.add('show');
  }

  function viewPreviewPayload() {
    const lock = selectedLock();
    if (!lock || !accessState.preview?.payload) return;
    openJsonModal(`Payload Preview — ${lock.deviceName || lock.linkId}`, accessState.preview.payload);
  }

  function viewTransferStatus() {
    const lock = selectedLock();
    if (!lock) return;
    const push = pushStateFor(lock.linkId);
    if (!push) return;
    openJsonModal('Transfer Status — ' + (lock.deviceName || lock.linkId), push);
  }

  function viewStatusDetail(key) {
    const lock = selectedLock();
    if (!lock) return;
    const push = pushStateFor(lock.linkId);
    if (!push) return;
    const dataMap = {
      request: push.requestPayload || push.pushResult?.requestPayload,
      response: push.rawPushResponse || push.pushResult?.initialResponse,
      liveStatus: push.rawStatus,
    };
    const titles = { request: 'Request Payload', response: 'Gateway Response', liveStatus: 'Lock Download Status' };
    if (dataMap[key]) openJsonModal(titles[key], dataMap[key]);
  }

  function setBooleanLockSetting(key, checked) {
    accessState.lockSettingsValues = {
      ...accessState.lockSettingsValues,
      [key]: !!checked,
    };
    renderLockSettings();
  }

  function setGeProxFormat(value) {
    accessState.lockSettingsValues = {
      ...accessState.lockSettingsValues,
      geProxFormat: ['4001', '4002'].includes(String(value)) ? String(value) : 'disabled',
    };
    renderLockSettings();
  }

  async function saveLockSettings() {
    const lock = selectedLock();
    if (!lock || accessState.lockSettingsSaving || !hasLockSettingsChanges()) return;

    accessState.lockSettingsSaving = true;
    renderLockSettings();

    try {
      const data = await api(`/api/access/lock-settings/${encodeURIComponent(lock.linkId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          gateway_sn: lock.sn,
          values: lockSettingsPayload(),
        }),
      });
      setLockSettingsState(data.settings || {});
      showToast(`Reader settings updated for ${lock.deviceName || lock.linkId}`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      accessState.lockSettingsSaving = false;
      renderLockSettings();
    }
  }

  function bindEvents() {
    document.getElementById('mode-live').addEventListener('click', () => switchView('live'));
    document.getElementById('mode-access').addEventListener('click', () => switchView('access'));
    document.getElementById('access-user-form').addEventListener('submit', saveUser);
    document.getElementById('access-schedule-form').addEventListener('submit', saveSchedule);
    document.getElementById('access-format-form').addEventListener('submit', saveFormat);
    document.getElementById('access-user-format').addEventListener('change', () => {
      accessState.userFormatTouched = true;
      refreshUserFormatHint(false);
    });
    document.getElementById('access-user-card').addEventListener('input', () => {
      if (!accessState.userFormatTouched) refreshUserFormatHint(true);
      else refreshUserFormatHint(false);
    });
    document.getElementById('access-user-facility').addEventListener('input', () => refreshUserFormatHint(!accessState.userFormatTouched));
    document.getElementById('access-user-issue').addEventListener('input', () => refreshUserFormatHint(!accessState.userFormatTouched));
    document.getElementById('access-format-suppress-fc').addEventListener('change', toggleFormatFacilityInputs);
  }

  // ── Learn Card from Swipe ──────────────────────────────────────────────────
  // Per Allegion training: swipe a card (denied) → capture raw bytes from audit events
  // → use those exact bytes to build PrimeCR → push → card now works!

  async function learnCardFromSwipe() {
    const lock = selectedLock();
    if (!lock) { showToast('Select a lock first', 'warn'); return; }
    try {
      showToast('Checking for last denied card...', 'info', 2000);
      const result = await api(`/api/access/last-denied/${encodeURIComponent(lock.linkId)}`);
      if (!result.ok) {
        showToast(result.message || 'No denied card found. Swipe a card on the lock first!', 'warn', 5000);
        return;
      }
      const info = [
        `Card Bit Count: ${result.cardBitCount}`,
        `Raw Card Hex: ${result.rawCardHex}`,
        `Clear PrimeCR: ${result.clearPrimeCrHex}`,
        `Encrypted PrimeCR: ${result.encryptedPrimeCrHex || '(no site key)'}`,
        result.cardNumber ? `Decoded Card #: ${result.cardNumber}` : null,
        result.facilityCode ? `Decoded FC: ${result.facilityCode}` : null,
        `Captured: ${result.timestamp}`,
      ].filter(Boolean).join('\n');

      if (confirm(`Last denied card on ${lock.deviceName || lock.linkId}:\n\n${info}\n\nEnroll this card? (Push to lock using raw bytes)`)) {
        await enrollSwipedCard();
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function enrollSwipedCard() {
    const lock = selectedLock();
    if (!lock) { showToast('Select a lock first', 'warn'); return; }
    try {
      showToast(`Enrolling swiped card on ${lock.deviceName || lock.linkId}...`, 'info', 5000);
      const result = await api(`/api/access/enroll-swipe/${encodeURIComponent(lock.linkId)}`, {
        method: 'POST',
        body: JSON.stringify({
          gateway_sn: lock.sn,
          name: 'Swiped Card Enrollment',
        }),
      });
      if (result.ok) {
        showToast(`Card enrolled! usrID=${result.enrolled.usrID}, ${result.enrolled.cardBitCount}-bit. DB push started. Swipe again to test!`, 'success', 8000);
        openJsonModal('Enroll Swipe Result — ' + (lock.deviceName || lock.linkId), result);
      } else {
        showToast('Enrollment failed: ' + (result.error || JSON.stringify(result)), 'error');
      }
      renderStatus();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  window.accessUI = {
    init: refreshState,
    switchView,
    selectLock(linkId, sn) {
      accessState.selectedLockId = linkId;
      accessState.selectedGatewaySn = sn;
      Promise.all([refreshPreview(), refreshLockSettings()]).then(renderAll);
    },
    refreshLockSettings,
    refreshStatus,
    pullDatabase,
    clearDatabase,
    learnCardFromSwipe,
    enrollSwipedCard,
    openJsonModal,
    viewPreviewPayload,
    viewTransferStatus,
    viewStatusDetail,
    saveLockSettings,
    setLockSetting: setBooleanLockSetting,
    setGeProxFormat,
    openUserModal,
    addUserFromSwipe,
    openScheduleModal,
    openFormatModal,
    closeModal,
    async deleteUser(id) {
      const existingUser = accessState.users.find(user => user.id === id) || null;
      try {
        await api(`/api/access/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refreshState();
        await autoPushLocks(existingUser?.lockIds || [], 'Credential');
      } catch (err) {
        showToast(err.message, 'error');
      }
    },
    async deleteSchedule(id) {
      const existingSchedule = accessState.schedules.find(schedule => schedule.id === id) || null;
      try {
        await api(`/api/access/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refreshState();
        await autoPushLocks(existingSchedule?.lockIds || [], 'Schedule');
      } catch (err) {
        showToast(err.message, 'error');
      }
    },
    async deleteFormat(id) {
      try {
        await api(`/api/access/formats/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refreshState(false);
        showToast('Custom card format deleted', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    },
    renderLocks,
    renderAll,
  };

  // Script loads after DOM is ready (at end of body), so call immediately
  bindEvents();
  ensureSelection();
  renderAll();
})();
