'use strict';

const fs = require('fs');
const defaultCardFormats = require('./defaultCardFormats');
const { generatePrimeCredential, decryptCredentialReport, maskCardNumber } = require('./PrimeCredential');
const { DEFAULT_SCHEDULE_ID, DAY_ORDER } = require('./AccessStateStore');

const DEFAULT_ACT_DT_TM = '20000101000000';
const DEFAULT_EXP_DT_TM = '20991231235959';

function toInt(value, fieldName) {
  if (value === null || value === undefined || value === '') {
    throw new Error(`${fieldName} is required`);
  }
  const num = Number(value);
  if (!Number.isInteger(num)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  return num;
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(v => String(v)).filter(Boolean))];
}

function uniqueSortedDays(days) {
  const set = new Set((Array.isArray(days) ? days : []).filter(day => DAY_ORDER.includes(day)));
  return DAY_ORDER.filter(day => set.has(day));
}

function isAlwaysOn(schedule) {
  return schedule.strtHr === 0 &&
    schedule.strtMn === 0 &&
    schedule.lngth === 1439 &&
    schedule.days.length === 7;
}

function firstCardDisplayValue(cardCandidates) {
  if (!Array.isArray(cardCandidates) || cardCandidates.length === 0) return null;
  return cardCandidates.find(candidate => /^\d+$/.test(String(candidate).trim())) || cardCandidates[0];
}

class AccessControlService {
  constructor(store, options = {}) {
    this.store = store;
    this.siteKeyFile = options.siteKeyFile || './config/sitekey';
    this._cachedSiteKey = null;
  }

  getState(availableLocks = [], pushStatuses = {}) {
    const snapshot = this.store.getSnapshot();
    return {
      users: snapshot.users,
      schedules: snapshot.schedules,
      customCardFormats: snapshot.customCardFormats,
      builtInCardFormats: defaultCardFormats,
      availableLocks,
      pushStatuses,
    };
  }

  getCardFormats() {
    const snapshot = this.store.getSnapshot();
    return [
      ...defaultCardFormats.map(f => ({ ...f, source: 'builtin' })),
      ...snapshot.customCardFormats.map(f => ({ ...f, source: 'custom' })),
    ];
  }

  upsertCustomCardFormat(input) {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Custom card format name is required');

    const payload = {
      offset: Number(input.payload?.offset || 0),
      total_card_bits: toInt(input.payload?.total_card_bits, 'total_card_bits'),
      format: String(input.payload?.format || 'WIEGAND').trim() || 'WIEGAND',
      total_even_parity_bits: Number(input.payload?.total_even_parity_bits || 0),
      even_parity_start_bit: Number(input.payload?.even_parity_start_bit || 0),
      total_odd_parity_bits: Number(input.payload?.total_odd_parity_bits || 0),
      odd_parity_start_bit: Number(input.payload?.odd_parity_start_bit || 0),
      total_facility_code_bits: Number(input.payload?.total_facility_code_bits || 0),
      facility_code_start_bit: Number(input.payload?.facility_code_start_bit || 0),
      total_cardholder_id_bits: toInt(input.payload?.total_cardholder_id_bits, 'total_cardholder_id_bits'),
      cardholder_id_start_bit: toInt(input.payload?.cardholder_id_start_bit, 'cardholder_id_start_bit'),
      card_format_code: String(input.payload?.card_format_code || name).trim(),
      is_parity_calculation_by_2_bits: !!input.payload?.is_parity_calculation_by_2_bits,
      is_corporate_card: !!input.payload?.is_corporate_card,
      is_37_bit_parity_test_with_4_bits: !!input.payload?.is_37_bit_parity_test_with_4_bits,
      is_37_bit_parity_test_with_2_bits: !!input.payload?.is_37_bit_parity_test_with_2_bits,
      is_48_bit_card_formatting: !!input.payload?.is_48_bit_card_formatting,
      is_special_card_format: !!input.payload?.is_special_card_format,
      is_reverse_card_format: !!input.payload?.is_reverse_card_format,
      is_large_encoded_id: !!input.payload?.is_large_encoded_id,
      is_reversal_of_bytes: !!input.payload?.is_reversal_of_bytes,
      is_37_bit_special_parity_test: !!input.payload?.is_37_bit_special_parity_test,
      is_200_bit_fascn_to_128_bit_version_conversation: !!input.payload?.is_200_bit_fascn_to_128_bit_version_conversation,
      is_card_id_check_with_other_formats: !!input.payload?.is_card_id_check_with_other_formats,
      enable_corporate_1000_parity_checks: !!input.payload?.enable_corporate_1000_parity_checks,
      total_issue_code_bits: Number(input.payload?.total_issue_code_bits || 0),
      issue_code_start_bit: Number(input.payload?.issue_code_start_bit || 0),
      min_number_of_digits: Number(input.payload?.min_number_of_digits || 0),
      max_number_of_digits: Number(input.payload?.max_number_of_digits || 0),
    };

    const fc = input.fc
      ? { min: toInt(input.fc.min, 'fc.min'), max: toInt(input.fc.max, 'fc.max') }
      : null;
    this._validateCustomFormat(payload, fc);
    const ts = new Date().toISOString();

    return this.store.mutate((state) => {
      let existing = state.customCardFormats.find(f => f.id === input.id);
      if (!existing) {
        existing = { id: this.store.createId('format'), createdAt: ts };
        state.customCardFormats.push(existing);
      }
      existing.name = name;
      existing.description = String(input.description || '').trim();
      existing.value = String(input.value || name).trim();
      existing.label = String(input.label || `${name}${existing.description ? ` - ${existing.description}` : ''}`).trim();
      existing.fc = fc;
      existing.payload = payload;
      existing.updatedAt = ts;
    });
  }

  deleteCustomCardFormat(id) {
    return this.store.mutate((state) => {
      const inUse = state.users.some(u => u.formatSource === 'custom' && u.formatId === id);
      if (inUse) {
        throw new Error('Cannot delete a custom card format that is in use');
      }
      state.customCardFormats = state.customCardFormats.filter(f => f.id !== id);
    });
  }

  upsertSchedule(input) {
    const ts = new Date().toISOString();
    const days = uniqueSortedDays(input.days);
    if (days.length === 0) throw new Error('At least one day is required');

    const strtHr = toInt(input.strtHr, 'strtHr');
    const strtMn = toInt(input.strtMn, 'strtMn');
    const lngth = toInt(input.lngth, 'lngth');
    if (strtHr < 0 || strtHr > 23) throw new Error('strtHr must be between 0 and 23');
    if (strtMn < 0 || strtMn > 59) throw new Error('strtMn must be between 0 and 59');
    if (lngth < 1 || lngth > 1439) throw new Error('lngth must be between 1 and 1439');

    return this.store.mutate((state) => {
      let schedule = state.schedules.find(s => s.id === input.id);
      if (!schedule) {
        schedule = { id: this.store.createId('schedule'), createdAt: ts, isDefault: false };
        state.schedules.push(schedule);
      }
      if (schedule.isDefault) {
        throw new Error('Default 24x7 schedule cannot be edited');
      }
      schedule.name = String(input.name || '').trim() || 'Untitled Schedule';
      schedule.description = String(input.description || '').trim();
      schedule.days = days;
      schedule.strtHr = strtHr;
      schedule.strtMn = strtMn;
      schedule.lngth = lngth;
      schedule.lockIds = normalizeStringList(input.lockIds);
      schedule.updatedAt = ts;
    });
  }

  deleteSchedule(id) {
    if (id === DEFAULT_SCHEDULE_ID) {
      throw new Error('Default 24x7 schedule cannot be deleted');
    }

    return this.store.mutate((state) => {
      const inUse = state.users.some(user => Array.isArray(user.scheduleIds) && user.scheduleIds.includes(id));
      if (inUse) {
        throw new Error('Cannot delete a schedule that is assigned to a user');
      }
      state.schedules = state.schedules.filter(s => s.id !== id);
    });
  }

  upsertUser(input) {
    const usrID = toInt(input.usrID, 'usrID');
    const name = String(input.name || '').trim();
    const cardNumber = String(input.cardNumber || '').trim();
    if (!cardNumber) throw new Error('Card number is required');
    const scheduleIds = normalizeStringList(input.scheduleIds);
    const lockIds = normalizeStringList(input.lockIds);
    if (lockIds.length === 0) throw new Error('Assign the user to at least one lock');

    const formatInfo = this._resolveFormatReference(input.formatSource, input.formatId);
    const payload = this._generatePrimeCredential({
      format: formatInfo.format,
      cardNumber,
      facilityCode: input.facilityCode,
      issueCode: input.issueCode,
    });

    return this.store.mutate((state) => {
      const duplicateUsrId = state.users.find(u => u.usrID === usrID && u.id !== input.id);
      if (duplicateUsrId) {
        throw new Error(`usrID ${usrID} is already in use`);
      }

      let user = state.users.find(u => u.id === input.id);
      const ts = new Date().toISOString();
      if (!user) {
        user = { id: this.store.createId('user'), createdAt: ts };
        state.users.push(user);
      }

      user.name = name;
      user.usrID = usrID;
      user.cardNumber = cardNumber;
      user.maskedCardNumber = maskCardNumber(cardNumber);
      user.facilityCode = input.facilityCode === '' ? null : (input.facilityCode ?? null);
      user.issueCode = input.issueCode === '' ? null : (input.issueCode ?? null);
      user.formatSource = formatInfo.source;
      user.formatId = formatInfo.id;
      user.formatValue = formatInfo.value;
      user.formatLabel = formatInfo.label;
      user.scheduleIds = scheduleIds.length > 0 ? scheduleIds : [DEFAULT_SCHEDULE_ID];
      user.lockIds = lockIds;
      user.adaEn = Number(input.adaEn || 0);
      user.fnctn = String(input.fnctn || 'norm').trim() || 'norm';
      user.actDtTm = String(input.actDtTm || DEFAULT_ACT_DT_TM);
      user.expDtTm = String(input.expDtTm || DEFAULT_EXP_DT_TM);
      user.lastPrimePreview = {
        clearHex: payload.clearHex,
        encryptedHex: payload.encryptedHex,
      };
      user.updatedAt = ts;
    });
  }

  deleteUser(id) {
    return this.store.mutate((state) => {
      state.users = state.users.filter(u => u.id !== id);
    });
  }

  buildPreview(linkId) {
    const snapshot = this.store.getSnapshot();
    const assignedUsers = snapshot.users.filter(u => Array.isArray(u.lockIds) && u.lockIds.includes(linkId));
    const selectedScheduleIds = new Set([DEFAULT_SCHEDULE_ID]);

    snapshot.schedules
      .filter(s => Array.isArray(s.lockIds) && s.lockIds.includes(linkId))
      .forEach(s => selectedScheduleIds.add(s.id));

    assignedUsers.forEach(user => {
      const scheduleIds = Array.isArray(user.scheduleIds) && user.scheduleIds.length > 0
        ? user.scheduleIds
        : [DEFAULT_SCHEDULE_ID];
      scheduleIds.forEach(id => selectedScheduleIds.add(id));
    });

    const schedules = snapshot.schedules
      .filter(s => selectedScheduleIds.has(s.id))
      .sort((a, b) => {
        if (a.id === DEFAULT_SCHEDULE_ID) return -1;
        if (b.id === DEFAULT_SCHEDULE_ID) return 1;
        return String(a.name).localeCompare(String(b.name));
      });

    const scheduleIndexById = new Map(schedules.map((schedule, idx) => [schedule.id, idx + 1]));

    const addRecords = assignedUsers.map((user) => {
      const format = this._resolveFormatFromSnapshot(snapshot, user.formatSource, user.formatId);
      const prime = this._generatePrimeCredential({
        format,
        cardNumber: user.cardNumber,
        facilityCode: user.facilityCode,
        issueCode: user.issueCode,
      });

      const crSch = (Array.isArray(user.scheduleIds) && user.scheduleIds.length > 0
        ? user.scheduleIds
        : [DEFAULT_SCHEDULE_ID]
      )
        .filter(id => scheduleIndexById.has(id))
        .map(id => scheduleIndexById.get(id))
        .sort((a, b) => a - b);

      return {
        usrID: user.usrID,
        adaEn: Number(user.adaEn || 0),
        actDtTm: String(user.actDtTm || DEFAULT_ACT_DT_TM),
        expDtTm: String(user.expDtTm || DEFAULT_EXP_DT_TM),
        fnctn: user.fnctn || 'norm',
        crSch,
        primeCr: prime.encryptedHex,
        prCrTyp: 'card',
        _clearPrimeCr: prime.clearHex,
      };
    }).sort((a, b) => a._clearPrimeCr.localeCompare(b._clearPrimeCr));

    const add = addRecords.map(({ _clearPrimeCr, ...record }) => record);
    const wireSchedules = schedules.map(schedule => ({
      days: schedule.days,
      strtHr: schedule.strtHr,
      strtMn: schedule.strtMn,
      lngth: schedule.lngth,
    }));

    return {
      linkId,
      payload: {
        db: {
          usrRcrd: {
            deleteAll: 1,
            delete: [],
            update: [],
            add,
          },
          schedules: wireSchedules,
          holidays: [],
          autoUnlock: [],
        },
        nxtDbVerTS: this._nextDbVersion(),
      },
      summary: {
        mode: 'full-replace',
        deleteAll: 1,
        userCount: add.length,
        scheduleCount: wireSchedules.length,
      },
      scheduleMappings: schedules.map((schedule, idx) => ({
        wireIndex: idx + 1,
        id: schedule.id,
        name: schedule.name,
        isDefault: !!schedule.isDefault,
        days: schedule.days,
        strtHr: schedule.strtHr,
        strtMn: schedule.strtMn,
        lngth: schedule.lngth,
        alwaysOn: isAlwaysOn(schedule),
      })),
      assignedUsers: assignedUsers.map(user => ({
        id: user.id,
        usrID: user.usrID,
        name: user.name,
        maskedCardNumber: user.maskedCardNumber,
        formatLabel: user.formatLabel,
        lockIds: user.lockIds,
      })),
    };
  }

  resolveAccessEvent(linkId, parsedBody = {}) {
    const snapshot = this.store.getSnapshot();
    const candidates = snapshot.users.filter(user => Array.isArray(user.lockIds) && user.lockIds.includes(linkId));

    const userIdCandidates = [
      parsedBody.userId,
      parsedBody.user_id,
      parsedBody.usrID,
    ].filter(v => v !== null && v !== undefined && v !== '');

    let matchedUser = null;
    for (const candidate of userIdCandidates) {
      const num = Number(candidate);
      matchedUser = candidates.find(user => user.usrID === num);
      if (matchedUser) break;
    }

    const cardCandidates = [
      parsedBody.cardNumber,
      parsedBody.badgeId,
      parsedBody.badge_id,
      parsedBody.card_number,
    ].filter(Boolean).map(v => String(v).trim());

    if (!matchedUser && cardCandidates.length > 0) {
      matchedUser = candidates.find(user =>
        cardCandidates.includes(String(user.cardNumber || '').trim()) ||
        cardCandidates.includes(String(user.maskedCardNumber || '').trim())
      );
    }

    let presentedCard = firstCardDisplayValue(cardCandidates);
    let decodedCredential = null;

    // If no card number found from standard fields, try decrypting credentialReport
    if (!presentedCard && !matchedUser) {
      const credReport = Array.isArray(parsedBody.credentialReport)
        ? parsedBody.credentialReport
        : [];
      const credHex = credReport[0]?.cred;
      if (credHex) {
        try {
          if (!this._cachedSiteKey) {
            try { this._cachedSiteKey = fs.readFileSync(this.siteKeyFile, 'utf8').trim(); } catch { /* no site key */ }
          }
          if (this._cachedSiteKey) {
            const siteKey = this._cachedSiteKey;
            const allFormats = [...defaultCardFormats, ...(snapshot.customCardFormats || [])];
            decodedCredential = decryptCredentialReport(credHex, siteKey, allFormats);
            if (decodedCredential?.cardNumber) {
              presentedCard = decodedCredential.cardNumber;
              // Try to match decoded card number against configured users
              matchedUser = candidates.find(user =>
                String(user.cardNumber || '').trim() === presentedCard
              );
            }
          }
        } catch { /* decryption failed — continue without card number */ }
      }
    }

    const subject = matchedUser?.name
      ? matchedUser.name
      : matchedUser
        ? `User ${matchedUser.usrID}`
        : presentedCard
          ? `Card ${presentedCard}`
          : userIdCandidates.length > 0
            ? `User ${userIdCandidates[0]}`
            : 'Unknown credential';

    return {
      user: matchedUser ? {
        id: matchedUser.id,
        name: matchedUser.name,
        usrID: matchedUser.usrID,
        maskedCardNumber: matchedUser.maskedCardNumber,
      } : null,
      subject,
      presentedCardNumber: presentedCard,
      decodedCredential,
    };
  }

  _resolveFormatReference(source, id) {
    const snapshot = this.store.getSnapshot();
    return this._resolveFormatFromSnapshot(snapshot, source, id, true);
  }

  _resolveFormatFromSnapshot(snapshot, source, id, withMetadata = false) {
    let format = null;
    let metadata = null;
    if (source === 'builtin') {
      format = defaultCardFormats.find(f => f.value === id);
      metadata = format ? { source, id: format.value, value: format.value, label: format.label, format } : null;
    } else if (source === 'custom') {
      format = snapshot.customCardFormats.find(f => f.id === id);
      metadata = format ? { source, id: format.id, value: format.value || format.id, label: format.label || format.name, format } : null;
    }

    if (!metadata) {
      throw new Error('Selected card format was not found');
    }
    return withMetadata ? metadata : metadata.format;
  }

  _generatePrimeCredential(options) {
    if (!fs.existsSync(this.siteKeyFile)) {
      throw new Error(`Site key file not found: ${this.siteKeyFile}`);
    }
    const siteKey = fs.readFileSync(this.siteKeyFile, 'utf8').trim();
    return generatePrimeCredential({
      ...options,
      siteKey,
    });
  }

  _nextDbVersion() {
    return `0x${Date.now().toString(16).padStart(16, '0')}`;
  }

  _validateCustomFormat(payload, fc) {
    const totalBits = Number(payload.total_card_bits || 0);
    if (totalBits < 1 || totalBits > 128) {
      throw new Error('total_card_bits must be between 1 and 128');
    }

    if (fc && fc.min > fc.max) {
      throw new Error('fc.min must be less than or equal to fc.max');
    }

    const ranges = [
      ['cardholder bits', payload.cardholder_id_start_bit, payload.total_cardholder_id_bits],
      ['facility code bits', payload.facility_code_start_bit, payload.total_facility_code_bits],
      ['issue code bits', payload.issue_code_start_bit, payload.total_issue_code_bits],
      ['even parity bits', payload.even_parity_start_bit, payload.total_even_parity_bits],
      ['odd parity bits', payload.odd_parity_start_bit, payload.total_odd_parity_bits],
    ];

    ranges.forEach(([label, start, size]) => {
      const bitCount = Number(size || 0);
      const bitStart = Number(start || 0);
      if (bitCount < 0 || bitStart < 0) {
        throw new Error(`${label} must use non-negative values`);
      }
      if (bitCount > 0 && bitStart + bitCount > totalBits) {
        throw new Error(`${label} exceed total_card_bits`);
      }
    });
  }
}

module.exports = AccessControlService;
