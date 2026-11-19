import type { Revision } from "../formats";

export const revision: Revision = {
  id: "a73fe142ea5c",
  parent: "c52d95a61ae4",
  description: "Add voice mode RPCs and the snapshot's voice state",
  // RPC additions leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
