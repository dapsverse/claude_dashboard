/** Match pending tools and questions to live workers, never to a completed dispatch. */
export function officeCalls(permissions, runs) {
  const callingRunIds = new Set();
  // App displays a permission or question modal whenever this queue is nonempty. The boss holds
  // the handset while that modal awaits the user's answer, regardless of which worker owns it;
  // matching requests to workers only decides which of their own handsets should also stay up.
  const bossCalling = permissions.length > 0;
  for (const request of permissions) {
    const run = request.agentId == null ? null : runs.find((candidate) => (
      candidate.status === 'running' && candidate.agentId === request.agentId
      && (request.projectPath == null || candidate.projectPath == null
        || candidate.projectPath === request.projectPath)
    ));
    if (run) callingRunIds.add(run.id);
  }
  return { callingRunIds, bossCalling };
}
