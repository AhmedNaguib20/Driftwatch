'use client'

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { Sample } from '@/lib/metrics'

const logResize = () => console.log('chart resized')

export default function Chart({ data }: { data: Sample[] }) {
  return (
    <div style={{ width: '100%', height: 280 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: -16 }}>
          <CartesianGrid stroke="#1e2530" strokeDasharray="3 3" />
          <XAxis dataKey="day" stroke="#98a2b3" fontSize={12} />
          <YAxis stroke="#98a2b3" fontSize={12} />
          <Tooltip
            contentStyle={{ background: '#0b0d10', border: '1px solid #1e2530', borderRadius: 8 }}
          />
          <Line type="monotone" dataKey="buildTime" stroke="#7dd3fc" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="bundleKb" stroke="#fca5a5" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
