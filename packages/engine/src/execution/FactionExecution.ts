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

/**
 * M7C stage 3: found a faction, join the faction led by `targetID`, or
 * leave ours. One-shot.
 */
export class FactionExecution implements Execution {
  constructor(
    private player: Player,
    private mode: "found" | "join" | "leave",
    private targetID: PlayerID,
  ) {}

  init(mg: Game, _: number): void {
    const gs = grandStrategyOf(mg);
    if (gs === null || !this.player.isAlive()) return;
    let result: string;
    if (this.mode === "found") {
      result = gs.foundFaction(this.player);
    } else if (this.mode === "leave") {
      result = gs.leaveFaction(this.player);
    } else {
      if (!mg.hasPlayer(this.targetID)) {
        console.warn(`FactionExecution target ${this.targetID} not found`);
        return;
      }
      result = gs.joinFaction(this.player, mg.player(this.targetID));
    }
    if (result !== "ok") {
      console.warn(
        `${this.player.displayName()} cannot ${this.mode} faction: ${result}`,
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
    return FactionExecutionSnapshot.write({
      player: w.player(this.player),
      mode: this.mode,
      targetID: this.targetID,
    });
  }

  restoreSnapshot(s: FactionState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.mode = s.mode;
    this.targetID = s.targetID;
  }
}

const FactionStateSchema = z.object({
  player: zPlayerRef(),
  mode: z.enum(["found", "join", "leave"]),
  targetID: z.string(),
});
type FactionState = z.infer<typeof FactionStateSchema>;

export const FactionExecutionSnapshot = execSnapshotType({
  name: "Faction",
  version: 1,
  schema: FactionStateSchema,
  cls: () => FactionExecution,
});
