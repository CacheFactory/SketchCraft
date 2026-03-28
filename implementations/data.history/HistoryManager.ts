// @archigraph svc.history_manager
// Snapshot-based undo/redo. Each transaction stores a full geometry snapshot
// taken before the operation. Undo restores the snapshot; redo reapplies.

import { v4 as uuid } from 'uuid';
import { SimpleEventEmitter } from '../../src/core/events';
import { ITransaction, IHistoryManager } from '../../src/core/interfaces';

// ─── Snapshot transaction ────────────────────────────────────────

interface SnapshotTransaction {
  id: string;
  name: string;
  timestamp: number;
  /** Geometry state BEFORE this transaction was committed. */
  beforeSnapshot: ArrayBuffer;
  /** Geometry state AFTER this transaction was committed. */
  afterSnapshot: ArrayBuffer | null;
}

type HistoryEvents = {
  'changed': [];
};

// ─── HistoryManager ──────────────────────────────────────────────

export class HistoryManager implements IHistoryManager {
  maxSteps = 100;

  private undoStack: SnapshotTransaction[] = [];
  private redoStack: SnapshotTransaction[] = [];
  private activeTransaction: SnapshotTransaction | null = null;
  private emitter = new SimpleEventEmitter<HistoryEvents>();

  /**
   * Callback to capture and restore geometry state.
   * Must be set by ModelDocument during initialization.
   */
  private _serialize: (() => ArrayBuffer) | null = null;
  private _deserialize: ((data: ArrayBuffer) => void) | null = null;

  /** Wire up serialization/deserialization for snapshot-based undo/redo. */
  setSnapshotCallbacks(
    serialize: () => ArrayBuffer,
    deserialize: (data: ArrayBuffer) => void,
  ): void {
    this._serialize = serialize;
    this._deserialize = deserialize;
  }

  // ── Transaction lifecycle ────────────────────────────────────

  beginTransaction(name: string): void {
    if (this.activeTransaction) {
      // Silently commit the previous transaction instead of throwing
      this.commitTransaction();
    }

    // Snapshot current state BEFORE the operation
    const beforeSnapshot = this._serialize ? this._serialize() : new ArrayBuffer(0);

    this.activeTransaction = {
      id: uuid(),
      name,
      timestamp: Date.now(),
      beforeSnapshot,
      afterSnapshot: null,
    };
  }

  commitTransaction(): ITransaction {
    if (!this.activeTransaction) {
      // No-op if nothing to commit
      return { id: uuid(), name: '(empty)', timestamp: Date.now() };
    }

    const tx = this.activeTransaction;
    this.activeTransaction = null;

    // Snapshot state AFTER the operation
    tx.afterSnapshot = this._serialize ? this._serialize() : new ArrayBuffer(0);

    this.undoStack.push(tx);

    // Prune oldest when exceeding max steps
    while (this.undoStack.length > this.maxSteps) {
      this.undoStack.shift();
    }

    // Clear redo stack on new commit
    this.redoStack.length = 0;

    this.emitter.emit('changed');
    return { id: tx.id, name: tx.name, timestamp: tx.timestamp };
  }

  abortTransaction(): void {
    if (!this.activeTransaction) return;

    // Restore state from before this transaction started
    if (this._deserialize && this.activeTransaction.beforeSnapshot.byteLength > 0) {
      this._deserialize(this.activeTransaction.beforeSnapshot);
    }

    this.activeTransaction = null;
  }

  // ── Recording (no-op in snapshot mode, kept for interface compat) ──

  recordAdd(_entityType: string, _entityId: string, _data: unknown): void {}
  recordRemove(_entityType: string, _entityId: string, _data: unknown): void {}
  recordModify(_entityType: string, _entityId: string, _before: unknown, _after: unknown): void {}

  // ── Undo / Redo ──────────────────────────────────────────────

  undo(): ITransaction | null {
    if (!this.canUndo) return null;

    const tx = this.undoStack.pop()!;

    // Restore to the state BEFORE this transaction
    if (this._deserialize && tx.beforeSnapshot.byteLength > 0) {
      this._deserialize(tx.beforeSnapshot);
    }

    this.redoStack.push(tx);
    this.emitter.emit('changed');
    return { id: tx.id, name: tx.name, timestamp: tx.timestamp };
  }

  redo(): ITransaction | null {
    if (!this.canRedo) return null;

    const tx = this.redoStack.pop()!;

    // Restore to the state AFTER this transaction
    if (this._deserialize && tx.afterSnapshot && tx.afterSnapshot.byteLength > 0) {
      this._deserialize(tx.afterSnapshot);
    }

    this.undoStack.push(tx);
    this.emitter.emit('changed');
    return { id: tx.id, name: tx.name, timestamp: tx.timestamp };
  }

  // ── Accessors ────────────────────────────────────────────────

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoName(): string | null {
    if (this.undoStack.length === 0) return null;
    return this.undoStack[this.undoStack.length - 1].name;
  }

  get redoName(): string | null {
    if (this.redoStack.length === 0) return null;
    return this.redoStack[this.redoStack.length - 1].name;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.activeTransaction = null;
    this.emitter.emit('changed');
  }

  // ── Events ─────────────────────────────────────────────────

  on(event: 'changed', handler: () => void): void {
    this.emitter.on(event, handler);
  }

  off(event: 'changed', handler: () => void): void {
    this.emitter.off(event, handler);
  }
}
