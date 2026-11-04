// A missing comparison ref is a transfer owned by the comparison request.
// Use the same immutable plan, credentials, deadline and audit as explicit Fetch.
export const fetchMissingRangeRef = async ({ directory, remote, branch, response, getSourceControlBinding, networkOperations }) => {
  const error = (message, code, status = 409) => Object.assign(new Error(message), { code, status });
  if (!networkOperations || !getSourceControlBinding) {
    throw error('Git network operations are unavailable', 'RUNTIME_UNSUPPORTED', 501);
  }
  let stopped = response.destroyed;
  let operationId;
  let cancellation;
  const cancel = () => {
    stopped = true;
    if (operationId && !cancellation) {
      cancellation = Promise.resolve(networkOperations.cancel(operationId)).catch((failure) => {
        console.warn('[git] comparison fetch cancellation failed:', failure?.code ?? 'UNKNOWN');
      });
    }
  };
  const assertActive = () => {
    if (stopped) throw error('Git comparison was cancelled', 'CANCELLED');
  };
  response.once('close', cancel);
  try {
    assertActive();
    const read = await getSourceControlBinding(directory);
    assertActive();
    const binding = read.binding;
    const grant = binding?.remotes.find((entry) => entry.name === remote);
    const configured = read.repository.remotes.find((entry) => entry.name === remote);
    if (!binding || binding.repositoryId !== read.repository.repositoryId || binding.revision !== read.revision
      || !grant || grant.readiness !== 'ready' || !configured
      || grant.fetch.fingerprint !== configured.fetch.fingerprint || grant.push.fingerprint !== configured.push.fingerprint) {
      throw error('Configure the repository connection before fetching the missing comparison branch.', 'SOURCE_CONTROL_BINDING_REQUIRED');
    }
    const plan = await networkOperations.plan({
      operation: 'fetch', fetchScope: 'ref', directory,
      repositoryId: binding.repositoryId, bindingRevision: binding.revision, configRevision: read.repository.configRevision,
      remote: { name: remote, endpoint: grant.fetch }, transportMode: grant.mode,
      sourceRef: `refs/heads/${branch}`, destinationRef: `refs/remotes/${remote}/${branch}`,
    });
    operationId = plan.operationId;
    if (stopped) cancel();
    assertActive();
    response.setHeader('X-OpenChamber-Git-Operation', operationId);
    const result = await networkOperations.execute(operationId);
    assertActive();
    if (result.state !== 'succeeded') {
      throw Object.assign(error(result.error?.message ?? 'Fetching the comparison branch failed', result.error?.code ?? 'GIT_FETCH_FAILED'), { operationId });
    }
  } catch (failure) {
    throw Object.assign(new Error('Comparison fetch failed', { cause: failure }), {
      rangeFetch: true, code: failure?.code, status: failure?.status, operationId,
    });
  } finally {
    response.off('close', cancel);
    await cancellation;
  }
};
