import express from 'express';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const config = {
  feeds: {
    trips: "https://api.bart.gov/gtfsrt/tripupdate.aspx",
    alerts: "https://api.bart.gov/gtfsrt/alerts.aspx",
  },
  station: {
    id: "M30-2", // Powell St Platform 2
    direction: "eastbound".toLowerCase(),
  },
  port: 3001,
  host: '0.0.0.0'
};

// Load static GTFS data
let staticData = {
  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: new Map()
};

function loadStaticData() {
  try {
    // Load stops
    const stopsContent = readFileSync(join(__dirname, 'gtfs-static-data', 'stops.txt'), 'utf-8');
    const stops = parse(stopsContent, { columns: true, skip_empty_lines: true });
    stops.forEach(stop => {
      staticData.stops.set(stop.stop_id, stop);
    });
    console.log(`Loaded ${staticData.stops.size} stops`);

    // Load routes
    const routesContent = readFileSync(join(__dirname, 'gtfs-static-data', 'routes.txt'), 'utf-8');
    const routes = parse(routesContent, { columns: true, skip_empty_lines: true });
    routes.forEach(route => {
      staticData.routes.set(route.route_id, route);
    });
    console.log(`Loaded ${staticData.routes.size} routes`);

    // Load trips
    const tripsContent = readFileSync(join(__dirname, 'gtfs-static-data', 'trips.txt'), 'utf-8');
    const trips = parse(tripsContent, { columns: true, skip_empty_lines: true });
    trips.forEach(trip => {
      staticData.trips.set(trip.trip_id, trip);
    });
    console.log(`Loaded ${staticData.trips.size} trips`);

    // Load stop_times and index by trip_id
    const stopTimesContent = readFileSync(join(__dirname, 'gtfs-static-data', 'stop_times.txt'), 'utf-8');
    const stopTimes = parse(stopTimesContent, { columns: true, skip_empty_lines: true });
    stopTimes.forEach(stopTime => {
      if (!staticData.stopTimes.has(stopTime.trip_id)) {
        staticData.stopTimes.set(stopTime.trip_id, []);
      }
      staticData.stopTimes.get(stopTime.trip_id).push(stopTime);
    });
    console.log(`Loaded stop times for ${staticData.stopTimes.size} trips`);
  } catch (error) {
    console.error('Error loading static GTFS data:', error);
  }
}

// Fetch GTFS-RT data with retry logic
async function fetchGtfsRtData(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        timeout: 5000 // 5 second timeout
      });
      
      if (!response.ok) {
        if (attempt < retries) {
          console.warn(`HTTP error ${response.status} from ${url}, retrying... (attempt ${attempt + 1}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
          continue;
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const buffer = await response.arrayBuffer();
      const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );
      return feed;
    } catch (error) {
      if (attempt < retries) {
        console.warn(`Error fetching from ${url}, retrying... (attempt ${attempt + 1}/${retries}):`, error.message);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        console.error(`Failed to fetch GTFS-RT data from ${url} after ${retries + 1} attempts:`, error.message);
        return null;
      }
    }
  }
  return null;
}

// Get stop information with real-time updates
async function getStopInfo(stopId, direction) {
  const stopInfo = {
    stop: null,
    upcomingTrips: [],
    alerts: [],
    warnings: [],
    lastUpdated: new Date().toISOString()
  };

  // Get static stop information
  const stop = staticData.stops.get(stopId);
  if (!stop) {
    throw new Error(`Stop ${stopId} not found`);
  }
  
  stopInfo.stop = {
    id: stop.stop_id,
    name: stop.stop_name,
    code: stop.stop_code,
    platform: stop.platform_code,
    lat: parseFloat(stop.stop_lat),
    lon: parseFloat(stop.stop_lon)
  };

  // Fetch real-time trip updates
  const tripsFeed = await fetchGtfsRtData(config.feeds.trips);
  if (!tripsFeed) {
    stopInfo.warnings.push('Real-time trip data temporarily unavailable');
  }
  
  if (tripsFeed) {
    const now = Math.floor(Date.now() / 1000);
    
    tripsFeed.entity.forEach(entity => {
      if (entity.tripUpdate) {
        const tripUpdate = entity.tripUpdate;
        const tripId = tripUpdate.trip?.tripId;
        
        if (!tripId) return;

        // Get trip details from static data
        const trip = staticData.trips.get(tripId);
        if (!trip) return;

        // Check if trip matches the direction
        const tripDirection = trip.direction_id === "0" ? "outbound" : "inbound";
        // For BART, we need to look at the route direction more carefully
        const route = staticData.routes.get(trip.route_id);
        
        // Get vehicle information if available (includes car count)
        const vehicle = tripUpdate.vehicle || entity.vehicle;
        
        // Find stop time updates for our stop
        tripUpdate.stopTimeUpdate?.forEach(stopTimeUpdate => {
          if (stopTimeUpdate.stopId === stopId) {
            const arrival = stopTimeUpdate.arrival;
            const departure = stopTimeUpdate.departure;
            
            if (arrival || departure) {
              const time = arrival?.time || departure?.time;
              const delay = arrival?.delay || departure?.delay || 0;
              
              // Only include future arrivals
              if (time && Number(time) > now) {
                const scheduledTime = Number(time) - delay;
                const arrivalTime = new Date(Number(time) * 1000);
                const minutesUntilArrival = Math.round((Number(time) - now) / 60);

                const tripInfo = {
                  tripId: tripId,
                  routeId: trip.route_id,
                  routeName: route?.route_short_name || trip.route_id,
                  routeLongName: route?.route_long_name || '',
                  headsign: trip.trip_headsign,
                  direction: tripDirection,
                  scheduledArrival: new Date(scheduledTime * 1000).toISOString(),
                  estimatedArrival: arrivalTime.toISOString(),
                  minutesUntilArrival: minutesUntilArrival,
                  delay: delay,
                  routeColor: route?.route_color ? `#${route.route_color}` : null,
                  routeTextColor: route?.route_text_color ? `#${route.route_text_color}` : null
                };
                
                // Add car count if available
                if (vehicle?.occupancyStatus !== undefined) {
                  tripInfo.occupancyStatus = vehicle.occupancyStatus;
                }
                if (vehicle?.label) {
                  tripInfo.vehicleLabel = vehicle.label;
                }
                
                stopInfo.upcomingTrips.push(tripInfo);
              }
            }
          }
        });
      }
    });

    // Sort by arrival time
    stopInfo.upcomingTrips.sort((a, b) => 
      new Date(a.estimatedArrival) - new Date(b.estimatedArrival)
    );

    // Filter by direction if specified
    if (direction) {
      stopInfo.upcomingTrips = stopInfo.upcomingTrips.filter(trip => {
        const routeName = trip.routeName?.toLowerCase() || '';
        const headsign = trip.headsign?.toLowerCase() || '';
        const routeLongName = trip.routeLongName?.toLowerCase() || '';
        
        // For BART, eastbound typically means away from SF
        if (direction === 'eastbound') {
          return routeName.includes('n') || 
                 headsign.includes('antioch') || 
                 headsign.includes('berryessa') ||
                 headsign.includes('dublin') ||
                 headsign.includes('pittsburg');
        } else if (direction === 'westbound') {
          return routeName.includes('s') || 
                 headsign.includes('millbrae') || 
                 headsign.includes('sfo') ||
                 headsign.includes('daly city') ||
                 headsign.includes('richmond');
        }
        return true;
      });
    }
  }

  // Fetch alerts
  const alertsFeed = await fetchGtfsRtData(config.feeds.alerts);
  if (!alertsFeed) {
    stopInfo.warnings.push('Real-time alerts data temporarily unavailable');
  }
  
  if (alertsFeed) {
    alertsFeed.entity.forEach(entity => {
      if (entity.alert) {
        const alert = entity.alert;
        
        // Check if alert affects our stop
        const affectsStop = alert.informedEntity?.some(ie => 
          ie.stopId === stopId
        );

        if (affectsStop) {
          stopInfo.alerts.push({
            header: alert.headerText?.translation?.[0]?.text || 'Alert',
            description: alert.descriptionText?.translation?.[0]?.text || '',
            url: alert.url?.translation?.[0]?.text || null,
            activePeriod: alert.activePeriod?.map(ap => ({
              start: ap.start ? new Date(Number(ap.start) * 1000).toISOString() : null,
              end: ap.end ? new Date(Number(ap.end) * 1000).toISOString() : null
            })) || []
          });
        }
      }
    });
  }

  return stopInfo;
}

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
      '/health': 'Health check endpoint'
    },
    configuration: {
      station: config.station,
      feeds: config.feeds
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    staticDataLoaded: {
      stops: staticData.stops.size,
      routes: staticData.routes.size,
      trips: staticData.trips.size
    }
  });
});

// Get configured station info
app.get('/station', async (req, res) => {
  try {
    const direction = req.query.direction || config.station.direction;
    const stopInfo = await getStopInfo(config.station.id, direction);
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
    const stopInfo = await getStopInfo(stopId, direction);
    res.json(stopInfo);
  } catch (error) {
    res.status(404).json({ 
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
    
    const stopInfo = await getStopInfo(stopId, direction);
    
    const nextArrivals = stopInfo.upcomingTrips.slice(0, limit).map(trip => {
      // Extract destination: split by " / " and take the last part
      // The destination can contain "/" but no spaces
      let destination = trip.headsign;
      const parts = destination.split(' / ');
      if (parts.length > 1) {
        destination = parts[parts.length - 1];
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
  const stops = Array.from(staticData.stops.values()).map(stop => ({
    id: stop.stop_id,
    name: stop.stop_name,
    code: stop.stop_code,
    platform: stop.platform_code
  }));
  res.json({ stops, count: stops.length });
});

// Start server
loadStaticData();

app.listen(config.port, config.host, () => {
  console.log(`\n🚇 BART GTFS Real-time API Server`);
  console.log(`📍 Station: ${config.station.id} (${staticData.stops.get(config.station.id)?.stop_name || 'Unknown'})`);
  console.log(`🧭 Direction: ${config.station.direction}`);
  console.log(`🌐 Server running on http://${config.host}:${config.port}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`  GET /                - API information`);
  console.log(`  GET /station         - Configured station info`);
  console.log(`  GET /station/:stopId - Any station info`);
  console.log(`  GET /next            - Next 4 arrivals (simplified)`);
  console.log(`  GET /stops           - List all stops`);
  console.log(`  GET /health          - Health check\n`);
});
