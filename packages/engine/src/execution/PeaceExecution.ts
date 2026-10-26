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
 * A player offers peace to a nation it is at war with, or accepts its
 * offer; or ("break") breaks a breakable truce with it. One-shot.
 */
export class PeaceExecution implements Execution {
  constructor(
    private player: Player,
    private targetID: PlayerID,
    private mode: "offer" | "break" = "offer",
  ) {}

  init(mg: Game, _: number): void {
    const gs = grandStrategyOf(mg);
    if (gs === null || !this.player.isAlive()) return;
    if (!mg.hasPlayer(this.targetID)) {
      console.warn(`PeaceExecution target ${this.targetID} not found`);
      return;
    }
    const target = mg.player(this.targetID);
    // Restored executions skip field initializers: absent mode = offer.
    if (this.mode === "break") {
      const result = gs.breakTruce(this.player, target);
      if (result !== "broken") {
        console.warn(
          `${this.player.displayName()} cannot break the truce with ${this.targetID}: ${result}`,
        );
      }
      return;
    }
    const result = gs.offerPeace(this.player, target);
    if (result !== "offered" && result !== "accepted") {
      console.warn(
        `${this.player.displayName()} cannot make peace with ${this.targetID}: ${result}`,
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
    return PeaceExecutionSnapshot.write({
      player: w.player(this.player),
      targetID: this.targetID,
      ...(this.mode === "break" ? { mode: "break" as const } : {}),
    });
  }

  restoreSnapshot(s: PeaceState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.targetID = s.targetID;
    this.mode = s.mode ?? "offer";
  }
}

const PeaceStateSchema = z.object({
  player: zPlayerRef(),
  targetID: z.string(),
  mode: z.enum(["offer", "break"]).optional(),
});
type PeaceState = z.infer<typeof PeaceStateSchema>;

export const PeaceExecutionSnapshot = execSnapshotType({
  name: "Peace",
  version: 1,
  schema: PeaceStateSchema,
  cls: () => PeaceExecution,
});
