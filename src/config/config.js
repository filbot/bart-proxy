import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '../../');

export const config = {
  feeds: {
    trips: process.env.BART_TRIPS_URL || "https://api.bart.gov/gtfsrt/tripupdate.aspx",
    alerts: process.env.BART_ALERTS_URL || "https://api.bart.gov/gtfsrt/alerts.aspx",
  },
  station: {
    id: process.env.STATION_ID || "M20-2", // Montgomery St. Station Platform 2 (Eastbound)
    direction: (process.env.STATION_DIRECTION || "eastbound").toLowerCase(),
  },
  port: parseInt(process.env.PORT, 10) || 3001,
  host: process.env.HOST || '0.0.0.0',
  paths: {
    staticData: join(rootDir, 'gtfs-static-data'),
  },
  refreshInterval: 30000, // 30 seconds
  cacheTTL: 60000, // Keep stale data for 1 minute data if fetch fails
};
