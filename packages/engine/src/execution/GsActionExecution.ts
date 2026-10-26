import {
  GS_ACTION_IDS,
  GsActionID,
} from "@openfront/engine-api/game/GameTypes";
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

/** A player takes a decision or hires an advisor with political power. One-shot. */
export class GsActionExecution implements Execution {
  constructor(
    private player: Player,
    private action: GsActionID,
  ) {}

  init(mg: Game, _: number): void {
    const gs = grandStrategyOf(mg);
    if (gs === null || !this.player.isAlive()) return;
    const result = gs.takeAction(this.player, this.action);
    if (result !== "ok") {
      console.warn(
        `${this.player.displayName()} cannot take ${this.action}: ${result}`,
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
    return GsActionExecutionSnapshot.write({
      player: w.player(this.player),
      action: this.action,
    });
  }

  restoreSnapshot(s: GsActionState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.action = s.action;
  }
}

const GsActionStateSchema = z.object({
  player: zPlayerRef(),
  action: z.enum(GS_ACTION_IDS),
});
type GsActionState = z.infer<typeof GsActionStateSchema>;

export const GsActionExecutionSnapshot = execSnapshotType({
  name: "GsAction",
  version: 1,
  schema: GsActionStateSchema,
  cls: () => GsActionExecution,
});
