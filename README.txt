STAY 0.7.1.10 — GPU result acceptance / recovery-loop fix

Root cause found from live behavior:
- WebGPU runTask() publishes telemetry when a GPU job completes.
- The transformed legacy client listened to every stay-gpu-status event.
- Every `ready:true` telemetry update called startWorkerPool('gpu-ready').
- startWorkerPool increments workerGeneration.
- Control then returned to dispatchGpuTask(), which saw its generation had changed
  and discarded the GPU result before POST /work.
- The server consequently saw zero verified candidates and invoked its 3-empty-epoch
  recovery watchdog repeatedly.

Fixes:
- GPU status only rebuilds compute on a real NOT READY -> READY transition.
- Routine GPU telemetry can no longer invalidate an in-flight result.
- Only one GPU task is allowed in flight per browser.
- A completed result is submitted; server decides if it is stale.
- If a newer epoch arrived while GPU was busy, the latest task starts immediately after.
- GPU telemetry now counts completed jobs.

No preserved 0.6 source/state is modified.

Suggested commit:
STAY 0.7.1.10 fix GPU result acceptance and recovery loop

Deploy:
sudo stay-deploy-git
