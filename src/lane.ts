/**
 * Who a lane process is.
 *
 * A lane is started by the front session with a few environment variables.
 * They exist before the first line of any extension runs and the model cannot
 * change them, which makes them the right channel for "you are a lane, not the
 * session a person types in".
 */

export const LANE_ENV = {
	/** The lane key. Set in every lane process. */
	lane: "PI_LANE",
	/** Human-readable name of the lane */
	label: "PI_LANE_LABEL",
	/** "1" when this lane may read what other lanes were asked (lanes_journal) */
	trusted: "PI_LANE_TRUSTED",
} as const;

export interface LaneIdentity {
	lane: string;
	label: string;
	trusted: boolean;
}

/** The lane this process runs, or undefined in the front session. */
export function laneIdentity(env: NodeJS.ProcessEnv = process.env): LaneIdentity | undefined {
	const lane = env[LANE_ENV.lane]?.trim();
	if (!lane) return undefined;
	return {
		lane,
		label: env[LANE_ENV.label]?.trim() || lane,
		trusted: env[LANE_ENV.trusted] === "1",
	};
}

export function laneEnv(identity: LaneIdentity): Record<string, string> {
	return {
		[LANE_ENV.lane]: identity.lane,
		[LANE_ENV.label]: identity.label,
		...(identity.trusted ? { [LANE_ENV.trusted]: "1" } : {}),
	};
}
