/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Radar, RadarChart, PolarGrid, PolarAngleAxis, ResponsiveContainer } from 'recharts';

interface ScoreChartProps {
  data: {
    subject: string;
    A: number;
    fullMark: number;
  }[];
  color?: string;
}

export function ScoreChart({ data, color = "#8884d8" }: ScoreChartProps) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart cx="50%" cy="50%" outerRadius="80%" data={data}>
          <PolarGrid stroke="#333" />
          <PolarAngleAxis dataKey="subject" tick={{ fill: '#666', fontSize: 10 }} />
          <Radar
            name="Score"
            dataKey="A"
            stroke={color}
            fill={color}
            fillOpacity={0.6}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
