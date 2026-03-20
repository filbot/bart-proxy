import { existsSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { config } from './src/config/config.js';
import { staticDataService } from './src/services/StaticDataService.js';
import { gtfsMonitor } from './src/services/GtfsMonitor.js';
import { transitService } from './src/services/TransitService.js';

import { gtfsUpdater } from './src/services/GtfsUpdater.js';

// Initialize Express app
const app = express();
app.use(express.json());

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'BART GTFS Real-time API',
    endpoints: {
      '/station': 'Get real-time information for the configured station',
      '/station/:stopId': 'Get real-time information for any station by stop ID',
      '/next': 'Get next 4 arrivals in simplified format (destination & minutes)',
      '/stops': 'List all available stops',
      '/health': 'Health check endpoint',
      '/status': 'Internal status of the monitor',
      '/update': 'Trigger manual GTFS update (admin)'
    },
    configuration: {
      // ...
      station: config.station,
      feeds: {
        trips: config.feeds.trips,
        alerts: config.feeds.alerts
      }
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  const status = gtfsMonitor.getStatus();
  const isHealthy = !status.trips.error || !!status.trips.hasData;

  const responseCode = isHealthy ? 200 : 503;

  res.status(responseCode).json({
    status: isHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    monitor: status,
    staticDataLoaded: staticDataService.getStats()
  });
});

// Internal Status
app.get('/status', (req, res) => {
  res.json(gtfsMonitor.getStatus());
});

// Get configured station info
app.get('/station', async (req, res) => {
  try {
    const direction = req.query.direction || config.station.direction;
    const stopInfo = await transitService.getStopInfo(config.station.id, direction);
    res.json(stopInfo);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get any station info by ID
app.get('/station/:stopId', async (req, res) => {
  try {
    const stopId = req.params.stopId;
    const direction = req.query.direction || null;
    const stopInfo = await transitService.getStopInfo(stopId, direction);
    res.json(stopInfo);
  } catch (error) {
    const status = error.message.includes('not found') ? 404 : 500;
    res.status(status).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get next arrivals in simplified format
app.get('/next', async (req, res) => {
  try {
    const stopId = req.query.stop || config.station.id;
    const direction = req.query.direction || config.station.direction;
    const limit = parseInt(req.query.limit) || 4;

    // Note: getStopInfo might throw if stopId is invalid
    const stopInfo = await transitService.getStopInfo(stopId, direction);

    const nextArrivals = stopInfo.upcomingTrips.slice(0, limit).map(trip => {
      // Extract destination: split by " / " and take the last part
      let destination = trip.headsign;
      if (destination) {
        const parts = destination.split(' / ');
        if (parts.length > 1) {
          destination = parts[parts.length - 1];
        }
      } else {
        destination = "Unknown";
      }

      // Determine status based on minutes until arrival
      const status = trip.minutesUntilArrival <= 1 ? 'arriving' : 'scheduled';

      const arrival = {
        destination: destination,
        minutesUntilArrival: trip.minutesUntilArrival,
        status: status
      };

      // Add car/vehicle information if available
      if (trip.vehicleLabel) {
        arrival.vehicle = trip.vehicleLabel;
      }
      if (trip.occupancyStatus !== undefined) {
        arrival.occupancy = trip.occupancyStatus;
      }

      return arrival;
    });

    res.json({
      station: stopInfo.stop.name,
      platform: stopInfo.stop.platform,
      direction: direction || 'all',
      nextArrivals: nextArrivals,
      lastUpdated: stopInfo.lastUpdated,
      ...(stopInfo.warnings.length > 0 && { warnings: stopInfo.warnings })
    });

  } catch (error) {
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// List all stops
app.get('/stops', (req, res) => {
  const stops = staticDataService.getAllStops().map(stop => ({
    id: stop.stop_id,
    name: stop.stop_name,
    code: stop.stop_code,
    platform: stop.platform_code
  }));
  res.json({ stops, count: stops.length });
});

// Update endpoint
app.post('/update', async (req, res) => {
  try {
    await gtfsUpdater.checkForUpdates();
    res.json({ status: 'Update executed', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start server
async function startServer() {
  try {
    // Download GTFS data if not present
    const stopsFile = join(config.paths.staticData, 'stops.txt');
    if (!existsSync(stopsFile)) {
      console.log('No GTFS static data found. Downloading...');
      await gtfsUpdater.checkForUpdates();
    }

    // Load Static Data
    staticDataService.load();

    // Start GTFS Monitor (Background polling)
    gtfsMonitor.start();

    // Start GTFS Updater (Daily check)
    gtfsUpdater.start();

    const server = app.listen(config.port, config.host, () => {
      console.log(`\n🚇 BART GTFS Real-time API Server`);
      console.log(`📍 Station: ${config.station.id} (${staticDataService.getStop(config.station.id)?.stop_name || 'Unknown'})`);
      console.log(`🧭 Direction: ${config.station.direction}`);
      console.log(`🌐 Server running on http://${config.host}:${config.port}`);
      console.log(`\nAvailable endpoints:`);
      console.log(`  GET /                - API information`);
      console.log(`  GET /station         - Configured station info`);
      console.log(`  GET /station/:stopId - Any station info`);
      console.log(`  GET /next            - Next 4 arrivals (simplified)`);
      console.log(`  GET /stops           - List all stops`);
      console.log(`  GET /health          - Health check`);
      console.log(`  GET /status          - Monitor status\n`);
    });

    function shutdown(signal) {
      console.log(`\n${signal} received. Shutting down gracefully...`);
      gtfsMonitor.stop();
      gtfsUpdater.stop();
      server.close(() => {
        console.log('Server closed.');
        process.exit(0);
      });
      setTimeout(() => {
        console.error('Forced shutdown after timeout.');
        process.exit(1);
      }, 5000);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (e) {
    console.error("Failed to start server:", e);
    process.exit(1);
  }
}

startServer();
