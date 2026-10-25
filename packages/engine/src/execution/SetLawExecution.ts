import { LAW_IDS, LawID } from "@openfront/engine-api/game/GameTypes";
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

/** A player changes one of its laws (conscription or economy). One-shot. */
export class SetLawExecution implements Execution {
  constructor(
    private player: Player,
    private law: LawID,
  ) {}

  init(mg: Game, _: number): void {
    const gs = grandStrategyOf(mg);
    if (gs === null || !this.player.isAlive()) return;
    const result = gs.setLaw(this.player, this.law);
    if (result !== "ok") {
      console.warn(
        `${this.player.displayName()} cannot adopt law ${this.law}: ${result}`,
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
    return SetLawExecutionSnapshot.write({
      player: w.player(this.player),
      law: this.law,
    });
  }

  restoreSnapshot(s: SetLawState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.law = s.law;
  }
}

const SetLawStateSchema = z.object({
  player: zPlayerRef(),
  law: z.enum(LAW_IDS),
});
type SetLawState = z.infer<typeof SetLawStateSchema>;

export const SetLawExecutionSnapshot = execSnapshotType({
  name: "SetLaw",
  version: 1,
  schema: SetLawStateSchema,
  cls: () => SetLawExecution,
});
