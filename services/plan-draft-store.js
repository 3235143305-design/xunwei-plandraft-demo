'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  assertPlanDraft,
  confirmPlanDraft,
  createPlanDraft,
  editPlanDraft
} = require('./plan-draft-service');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const storageError = () => publicError(500, '草稿存储暂不可用');
const copy = (value) => JSON.parse(JSON.stringify(value));
const VALID_STATUSES = new Set(['needs-input', 'draft-ready', 'confirmed']);

function createPlanDraftStore({
  dbPath,
  idFactory = crypto.randomUUID,
  busyTimeoutMs = 250
} = {}) {
  if (typeof dbPath !== 'string' || !dbPath.trim() || !path.isAbsolute(dbPath)) throw storageError();
  if (typeof idFactory !== 'function') throw storageError();
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000) throw storageError();

  let database;
  let closed = false;
  try {
    const directory = path.dirname(dbPath);
    const directoryExists = fs.existsSync(directory);
    if (!directoryExists) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = fs.lstatSync(directory);
    const wrongOwner = typeof process.getuid === 'function' && directoryStat.uid !== process.getuid();
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
      || (directoryStat.mode & 0o077) !== 0 || wrongOwner) throw storageError();
    if (fs.existsSync(dbPath) && fs.lstatSync(dbPath).isSymbolicLink()) throw storageError();
    database = new DatabaseSync(dbPath);
    fs.chmodSync(dbPath, 0o600);
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS plan_drafts (
        draft_id TEXT PRIMARY KEY,
        draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
        payload_json TEXT NOT NULL
      )
    `);
  } catch (_) {
    try { database?.close(); } catch (_) {}
    throw storageError();
  }

  const insertDraft = database.prepare(`
    INSERT INTO plan_drafts (draft_id, draft_revision, payload_json)
    VALUES (?, ?, ?)
  `);
  const selectDraft = database.prepare(`
    SELECT draft_id, draft_revision, payload_json FROM plan_drafts WHERE draft_id = ?
  `);
  const updateDraft = database.prepare(`
    UPDATE plan_drafts
    SET draft_revision = ?, payload_json = ?
    WHERE draft_id = ?
      AND draft_revision = ?
      AND payload_json = ?
  `);

  function ensureOpen() {
    if (closed) throw storageError();
  }

  function decodeStoredDraft(row, requestedDraftId) {
    try {
      const draft = JSON.parse(row.payload_json);
      assertPlanDraft(draft);
      if (row.draft_id !== requestedDraftId || draft.draftId !== requestedDraftId
        || row.draft_revision !== draft.draftRevision) throw storageError();
      return draft;
    } catch (_) {
      throw storageError();
    }
  }

  function create(input) {
    ensureOpen();
    try {
      const draftId = idFactory();
      if (typeof draftId !== 'string' || !UUID_PATTERN.test(draftId)) throw storageError();
      const draft = createPlanDraft({ ...input, draftId });
      insertDraft.run(draft.draftId, draft.draftRevision, JSON.stringify(draft));
      return copy(draft);
    } catch (error) {
      if (error?.status === 500) throw error;
      if (error instanceof TypeError) throw publicError(400, error.message);
      throw storageError();
    }
  }

  function get(draftId) {
    ensureOpen();
    if (typeof draftId !== 'string' || !UUID_PATTERN.test(draftId)) {
      throw publicError(400, '草稿标识无效');
    }
    try {
      const row = selectDraft.get(draftId);
      if (!row) throw publicError(404, '草稿不存在');
      const draft = decodeStoredDraft(row, draftId);
      return copy(draft);
    } catch (error) {
      if (error?.status === 404) throw error;
      throw storageError();
    }
  }

  function updateFromSnapshot(draftId, expectedSnapshot, transition) {
    ensureOpen();
    if (typeof draftId !== 'string' || !UUID_PATTERN.test(draftId)) {
      throw publicError(400, '草稿标识无效');
    }
    if (!expectedSnapshot || typeof expectedSnapshot !== 'object'
      || !Number.isInteger(expectedSnapshot.draftRevision)
      || expectedSnapshot.draftRevision < 1
      || !VALID_STATUSES.has(expectedSnapshot.status)) {
      throw publicError(400, '草稿快照无效');
    }

    try {
      const row = selectDraft.get(draftId);
      if (!row) throw publicError(404, '草稿不存在');
      const current = decodeStoredDraft(row, draftId);
      if (current.draftRevision !== expectedSnapshot.draftRevision
        || current.status !== expectedSnapshot.status) {
        throw publicError(409, '草稿已变化，请重新读取');
      }

      const next = transition(current);
      assertPlanDraft(next);
      const result = updateDraft.run(
        next.draftRevision,
        JSON.stringify(next),
        draftId,
        row.draft_revision,
        row.payload_json
      );
      if (Number(result.changes) !== 1) throw publicError(409, '草稿已变化，请重新读取');
      return copy(next);
    } catch (error) {
      if ([400, 404, 409].includes(error?.status)) throw error;
      if (error instanceof TypeError) throw publicError(400, error.message);
      throw storageError();
    }
  }

  function edit(draftId, expectedSnapshot, patch) {
    return updateFromSnapshot(draftId, expectedSnapshot, (current) => editPlanDraft(current, patch));
  }

  function confirm(draftId, expectedSnapshot) {
    return updateFromSnapshot(draftId, expectedSnapshot, (current) => {
      if (current.status === 'confirmed') throw publicError(409, '草稿已确认');
      try {
        return confirmPlanDraft(current, current.draftRevision);
      } catch (error) {
        throw publicError(400, error.message);
      }
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    try { database.close(); } catch (_) {}
  }

  return { create, get, edit, confirm, close };
}

module.exports = { createPlanDraftStore };
