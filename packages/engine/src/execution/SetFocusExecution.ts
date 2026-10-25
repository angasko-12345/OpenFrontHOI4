import { FOCUS_IDS, FocusID } from "@openfront/engine-api/game/GameTypes";
import { zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { grandStrategyOf } from "./GrandStrategyExecution";

/** A player picks the national focus to work on next. One-shot. */
export class SetFocusExecution implements Execution {
  constructor(
    private player: Player,
    private focus: FocusID,
  ) {}

  init(mg: Game, _: number): void {
    const gs = grandStrategyOf(mg);
    if (gs === null || !this.player.isAlive()) return;
    const result = gs.setFocus(this.player, this.focus);
    if (result !== "ok") {
      console.warn(
        `${this.player.displayName()} cannot start focus ${this.focus}: ${result}`,
      );
    }
  }

  tick(_: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return SetFocusExecutionSnapshot.write({
      player: w.player(this.player),
      focus: this.focus,
    });
  }

  restoreSnapshot(s: SetFocusState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.focus = s.focus;
  }
}

const SetFocusStateSchema = z.object({
  player: zPlayerRef(),
  focus: z.enum(FOCUS_IDS),
});
type SetFocusState = z.infer<typeof SetFocusStateSchema>;

export const SetFocusExecutionSnapshot = execSnapshotType({
  name: "SetFocus",
  version: 1,
  schema: SetFocusStateSchema,
  cls: () => SetFocusExecution,
});
