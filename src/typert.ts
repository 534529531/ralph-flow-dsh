import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry";
import { statusDescriptors } from "./status-contract.js";

/** Public registry artifact, kept explicit rather than requiring dsh's monorepo generator. */
export const TYPERT: TypertContribution = {
  package: "ralphflow-dsh", face: "host", schemas: [], invocations: statusDescriptors,
  model: { services: [{ key: "ralphflowStatus", exportName: "WorkflowStatusService", members: [], types: [], tags: [] }], events: [], objects: [] },
};
