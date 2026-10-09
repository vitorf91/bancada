import { execFileSync } from 'node:child_process'

/** `ps` TIME (`M:SS.cc`, or `H:MM:SS.cc`) as seconds. */
export function parseCpuTime(value: string): number {
  const parts = value.trim().split(':').map(Number)
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return seconds
}

/** Cumulative CPU seconds of one process, from `ps` (macOS `%cpu` is a decaying average, so deltas of TIME are used). */
export function processCpuSeconds(pid: number): number {
  try {
    return parseCpuTime(execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }))
  } catch {
    return 0
  }
}

/** Cumulative CPU seconds of the direct children of a process (the sessions' own processes). */
export function childrenCpuSeconds(parentPid: number): number {
  let total = 0
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time='], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      const [, ppid, time] = line.trim().split(/\s+/)
      if (Number(ppid) === parentPid && time) total += parseCpuTime(time)
    }
  } catch {
    // ps unavailable: report zero rather than fail the run
  }
  return total
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0
}

export interface LatencyStats {
  n: number
  p50: number
  p95: number
  p99: number
  max: number
}

export function latencyStats(values: number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  }
}

export interface MetricSample {
  type: string
  cpu: number
}

export interface CpuByRole {
  renderer: number
  gpu: number
  main: number
  other: number
}

/** Mean over the samples of the per-role sum (percent of one core). */
export function averageCpu(samples: MetricSample[][]): CpuByRole {
  const total: CpuByRole = { renderer: 0, gpu: 0, main: 0, other: 0 }
  if (samples.length === 0) return total
  for (const sample of samples) {
    for (const { type, cpu } of sample) {
      if (type === 'Tab') total.renderer += cpu
      else if (type === 'GPU') total.gpu += cpu
      else if (type === 'Browser') total.main += cpu
      else total.other += cpu
    }
  }
  return {
    renderer: total.renderer / samples.length,
    gpu: total.gpu / samples.length,
    main: total.main / samples.length,
    other: total.other / samples.length,
  }
}
