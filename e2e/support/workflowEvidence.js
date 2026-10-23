// Public workflow-evidence API used by journeys, scenarios and the WDIO hooks.
// The implementation lives in ./workflowEvidence/; this path stays stable for its many importers.

export {
  WORKFLOW_EVIDENCE_ROOT,
  workflowNameForJourney,
  workflowEvidenceDirectory,
} from './workflowEvidence/paths.js';
export {
  workflowFailureStepForTest,
  boundedWorkflowTestFailure,
} from './workflowEvidence/failure.js';
export {
  collectEvidenceProvenance,
} from './workflowEvidence/provenance.js';
export {
  applyWorkflowEvidenceRetention,
} from './workflowEvidence/retention.js';
export {
  refreshWorkflowEvidenceIndex,
} from './workflowEvidence/readme.js';
export {
  beginWorkflowEvidence,
  finalizeWorkflowEvidence,
  resetWorkflowEvidence,
  recordWorkflowTestFailure,
  recordWorkflowDiagnostic,
} from './workflowEvidence/lifecycle.js';
export {
  collectVisibleStateFromPage,
  validateVisibleState,
} from './workflowEvidence/visibleState.js';
export {
  promoteWorkflowFailureEvidence,
  captureWorkflowStep,
  runRootArtifactName,
  preserveRunRootEvidence,
  copyWorkflowArtifact,
} from './workflowEvidence/capture.js';
