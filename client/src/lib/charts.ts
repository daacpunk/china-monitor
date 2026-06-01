import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

// Brand-aligned chart palette — picked to match the Tailwind chart-N HSL vars.
export const CHART_COLORS = {
  primary: "hsl(221, 83%, 53%)",
  secondary: "hsl(262, 83%, 58%)",
  teal: "hsl(173, 58%, 45%)",
  amber: "hsl(43, 74%, 55%)",
  orange: "hsl(27, 87%, 60%)",
  emerald: "hsl(160, 64%, 40%)",
  red: "hsl(0, 72%, 51%)",
  muted: "hsl(0, 0%, 50%)",
};

export const NEW_COLOR = CHART_COLORS.emerald;
export const OLD_COLOR = CHART_COLORS.red;
export const NEUTRAL_COLOR = CHART_COLORS.muted;

export const baseChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: "index" as const, intersect: false },
  plugins: {
    legend: {
      position: "top" as const,
      align: "end" as const,
      labels: { boxWidth: 12, boxHeight: 8, padding: 14, font: { size: 11 } },
    },
    tooltip: {
      backgroundColor: "hsla(0, 0%, 7%, 0.92)",
      titleFont: { size: 12 },
      bodyFont: { size: 12 },
      padding: 10,
      cornerRadius: 6,
    },
  },
  scales: {
    x: {
      grid: { display: false },
      ticks: { font: { size: 11 } },
    },
    y: {
      grid: { color: "hsla(0, 0%, 50%, 0.12)" },
      ticks: { font: { size: 11 } },
    },
  },
};
