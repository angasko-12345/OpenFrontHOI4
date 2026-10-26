import { PlayerID } from "@openfront/engine-api/game/GameTypes";
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

/** A player starts justifying a war goal against another. One-shot. */
export class JustifyWarExecution implements Execution {
  constructor(
    private player: Player,
    private targetID: PlayerID,
  ) {}

  init(mg: Game, _: number): void {
    const gs = grandStrategyOf(mg);
    if (gs === null || !this.player.isAlive()) return;
    if (!mg.hasPlayer(this.targetID)) {
      console.warn(`JustifyWarExecution target ${this.targetID} not found`);
      return;
    }
    const result = gs.justifyWar(this.player, mg.player(this.targetID));
    if (result !== "ok") {
      console.warn(
        `${this.player.displayName()} cannot justify against ${this.targetID}: ${result}`,
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
    return JustifyWarExecutionSnapshot.write({
      player: w.player(this.player),
      targetID: this.targetID,
    });
  }

  restoreSnapshot(s: JustifyWarState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.targetID = s.targetID;
  }
}

const JustifyWarStateSchema = z.object({
  player: zPlayerRef(),
  targetID: z.string(),
});
type JustifyWarState = z.infer<typeof JustifyWarStateSchema>;

export const JustifyWarExecutionSnapshot = execSnapshotType({
  name: "JustifyWar",
  version: 1,
  schema: JustifyWarStateSchema,
  cls: () => JustifyWarExecution,
});
