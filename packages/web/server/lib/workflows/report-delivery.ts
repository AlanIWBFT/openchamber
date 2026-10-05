import { hasErrorMessage, hasErrorStatus } from './contracts.js';
import type { WorkflowRuntimeOptions } from './contracts.js';
import type { WorkflowRun } from './store.js';

type Report = NonNullable<WorkflowRun['report']>;
type Options = Pick<WorkflowRuntimeOptions, 'postSynthetic'> & {
  readArchive: WorkflowRuntimeOptions['agentSessions']['readParentArchive'];
  sleep: NonNullable<WorkflowRuntimeOptions['sleep']>;
  text: (run: WorkflowRun) => string;
  save: (run: WorkflowRun) => Promise<void>;
};

export const createReportDelivery = ({ postSynthetic, readArchive, sleep, text, save }: Options) => {
  const uncommitted = new WeakSet<Report>();
  const pending = new WeakMap<Report, Promise<void>>();
  const timers = new Map<Report, ReturnType<typeof setTimeout>>();
  let stopped = false;
  const cancel = (report: Report) => {
    clearTimeout(timers.get(report));
    timers.delete(report);
  };
  const send = async (run: WorkflowRun, report: Report, delay: number, final: boolean) => {
    const message = {
      id: report.messageId, text: text(run), description: run.name, delivery: 'steer',
      metadata: { source: 'openchamber-workflow', runId: run.id, name: run.name, state: run.state },
    };
    const attempts = delay || final ? 1 : 4;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if ((stopped && !final) || run.report !== report || report.delivered) return;
      let archived: 'active' | 'archived' | 'missing' = 'active';
      if (report.resume) {
        try {
          archived = await readArchive(run.directory, run.parentSessionId);
        } catch {
          if (attempt + 1 < attempts) await sleep(2000 * 2 ** attempt);
          continue;
        }
        if (stopped || run.report !== report) return;
      }
      try {
        if (archived !== 'missing') await postSynthetic(run.parentSessionId, { ...message, resume: report.resume && archived === 'active' });
      } catch (error) {
        if (!hasErrorStatus(error) || (error.status !== 409 && error.status !== 404)) {
          console.warn(`[workflows] delivering the report of ${run.id} failed:`, hasErrorMessage(error) ? error.message : error);
          if (attempt + 1 < attempts) await sleep(2000 * 2 ** attempt);
          continue;
        }
      }
      if (run.report !== report || report.delivered) return;
      report.delivered = true;
      cancel(report);
      await save(run).catch(error => console.warn(`[workflows] report ${report.messageId} of ${run.id} was delivered but its marker was not saved:`, hasErrorMessage(error) ? error.message : error));
      return;
    }
    if (stopped || run.report !== report || report.delivered || timers.has(report)) return;
    const nextDelay = Math.min(300_000, delay ? 2 * delay : 60_000);
    const timer = setTimeout(() => {
      timers.delete(report);
      if (run.report === report) void deliver(run, nextDelay);
    }, nextDelay);
    timer.unref();
    timers.set(report, timer);
  };
  const deliver = (run: WorkflowRun, delay = 0, final = false) => {
    const report = run.report;
    if (!report || (stopped && !(final && !report.resume)) || report.delivered || uncommitted.has(report)) return;
    const existing = pending.get(report);
    if (existing) return existing;
    const sending = send(run, report, delay, final).finally(() => pending.delete(report));
    pending.set(report, sending);
    return sending;
  };
  const shutdown = () => {
    stopped = true;
    for (const report of timers.keys()) cancel(report);
  };
  return { uncommitted, deliver, shutdown, deliverFinal: (run: WorkflowRun) => deliver(run, 0, true) };
};
