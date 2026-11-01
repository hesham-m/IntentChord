export function workspaceIndexAttemptIdempotencyKey(input: { taskId: string; analysisAttemptId: string; workspaceId: string }): string {
  return `unified-task:${input.taskId}:workspace-index:${input.analysisAttemptId}:${input.workspaceId}`;
}
