// A form owns one serial queue. Text drafts enter it only when committed by blur.
export function createSettingsAutosave({ revision, values = {}, read, write, readOutcome, createOperationId = () => crypto.randomUUID(), notify = () => {} }) {
  let baseline = structuredClone(values), pending = {}, running = false, error = "", conflict = false;
  let attempt = null;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const publish = () => notify({ saving: running, error, conflict, pending: Object.keys(pending).length > 0 });
  async function flush() {
    if (running || error || !Object.keys(pending).length) return;
    running = true; publish();
    try {
      while (Object.keys(pending).length) {
        const replay = attempt !== null;
        attempt ||= { expectedRevision: revision, values: { ...pending }, operationId: createOperationId() };
        const batch = attempt.values;
        try {
          const outcome = replay && readOutcome ? await readOutcome(attempt.operationId) : null;
          if (outcome?.status === "unknown") throw Object.assign(new Error("提交结果尚未确认，请稍后查询。"), { code: "operation_outcome_unknown" });
          if (!outcome?.saved) await write(attempt);
        }
        catch (cause) {
          if (cause.status === 409 && (!cause.code || cause.code === "revision_conflict")) {
            const latest = await read();
            conflict = Object.keys(batch).some(path => !same(latest.values[path], baseline[path]) && !same(latest.values[path], batch[path]));
            baseline = structuredClone(latest.values); revision = latest.record.revision;
            if (!conflict) { attempt = null; continue; }
          }
          throw cause;
        }
        // Read the authoritative revision; never infer it or submit the entire form.
        const latest = await read();
        baseline = structuredClone(latest.values); revision = latest.record.revision;
        for (const [path, value] of Object.entries(batch)) if (same(pending[path], value)) delete pending[path];
        attempt = null;
      }
    } catch (cause) {
      error = conflict ? "此字段已在另一处修改；输入已保留，请重新读取后核对。" : `保存失败：${cause.message}`;
    } finally { running = false; publish(); }
  }
  return {
    commit(changes) {
      for (const [path, value] of Object.entries(changes)) {
        if (!running && same(value, baseline[path])) delete pending[path];
        else pending[path] = structuredClone(value);
      }
      if (!conflict) error = "";
      publish(); void flush();
    },
    retry() { if (conflict) return; error = ""; void flush(); },
    get dirty() { return running || Object.keys(pending).length > 0; },
  };
}
