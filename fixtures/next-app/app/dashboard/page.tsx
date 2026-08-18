import { series } from '@/lib/metrics'
import Chart from './chart'

export default function DashboardPage() {
  const data = series()
  const last = data.at(-1)!

  return (
    <>
      <h1>Dashboard</h1>
      <p className="meta">
        Build time {last.buildTime}s · bundle {last.bundleKb} kB — synthetic, deterministic data.
      </p>
      <Chart data={data} />
    </>
  )
}
