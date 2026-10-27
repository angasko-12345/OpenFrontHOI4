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
 * M7 stage D: puppet a beaten nation ("demand", during its puppet
 * window), release our puppet `targetID` ("release"), or, as a puppet,
 * declare independence ("independence"; `targetID` is ignored). One-shot.
 */
export class PuppetExecution implements Execution {
  constructor(
    private player: Player,
    private mode: "demand" | "release" | "independence",
    private targetID: PlayerID,
  ) {}

  init(mg: Game, _: number): void {
    const gs = grandStrategyOf(mg);
    if (gs === null || !this.player.isAlive()) return;
    let result: string;
    if (this.mode === "independence") {
      result = gs.declareIndependence(this.player);
    } else {
      if (!mg.hasPlayer(this.targetID)) {
        console.warn(`PuppetExecution target ${this.targetID} not found`);
        return;
      }
      const target = mg.player(this.targetID);
      result =
        this.mode === "release"
          ? gs.releasePuppet(this.player, target)
          : gs.demandPuppet(this.player, target);
    }
    if (result !== "ok") {
      console.warn(
        `${this.player.displayName()} cannot ${this.mode} (puppet): ${result}`,
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
    return PuppetExecutionSnapshot.write({
      player: w.player(this.player),
      mode: this.mode,
      targetID: this.targetID,
    });
  }

  restoreSnapshot(s: PuppetState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.mode = s.mode;
    this.targetID = s.targetID;
  }
}

const PuppetStateSchema = z.object({
  player: zPlayerRef(),
  mode: z.enum(["demand", "release", "independence"]),
  targetID: z.string(),
});
type PuppetState = z.infer<typeof PuppetStateSchema>;

export const PuppetExecutionSnapshot = execSnapshotType({
  name: "Puppet",
  version: 1,
  schema: PuppetStateSchema,
  cls: () => PuppetExecution,
});
