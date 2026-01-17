import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config/config.js';

class StaticDataService {
    constructor() {
        this.stops = new Map();
        this.routes = new Map();
        this.trips = new Map();
        this.stopTimes = new Map();
        this.initialized = false;
    }

    load() {
        if (this.initialized) return;

        try {
            console.log('Loading static GTFS data...');

            // Load stops
            const stopsContent = readFileSync(join(config.paths.staticData, 'stops.txt'), 'utf-8');
            const stops = parse(stopsContent, { columns: true, skip_empty_lines: true });
            stops.forEach(stop => {
                this.stops.set(stop.stop_id, stop);
            });
            console.log(`Loaded ${this.stops.size} stops`);

            // Load routes
            const routesContent = readFileSync(join(config.paths.staticData, 'routes.txt'), 'utf-8');
            const routes = parse(routesContent, { columns: true, skip_empty_lines: true });
            routes.forEach(route => {
                this.routes.set(route.route_id, route);
            });
            console.log(`Loaded ${this.routes.size} routes`);

            // Load trips
            const tripsContent = readFileSync(join(config.paths.staticData, 'trips.txt'), 'utf-8');
            const trips = parse(tripsContent, { columns: true, skip_empty_lines: true });
            trips.forEach(trip => {
                this.trips.set(trip.trip_id, trip);
            });
            console.log(`Loaded ${this.trips.size} trips`);

            // Load stop_times and index by trip_id
            // This can be large, so we might want to optimize if memory is an issue
            const stopTimesContent = readFileSync(join(config.paths.staticData, 'stop_times.txt'), 'utf-8');
            const stopTimes = parse(stopTimesContent, { columns: true, skip_empty_lines: true });
            stopTimes.forEach(stopTime => {
                if (!this.stopTimes.has(stopTime.trip_id)) {
                    this.stopTimes.set(stopTime.trip_id, []);
                }
                this.stopTimes.get(stopTime.trip_id).push(stopTime);
            });
            console.log(`Loaded stop times for ${this.stopTimes.size} trips`);

            this.initialized = true;
        } catch (error) {
            console.error('Error loading static GTFS data:', error);
            throw error;
        }
    }

    reload() {
        console.log('Reloading static data...');
        this.stops.clear();
        this.routes.clear();
        this.trips.clear();
        this.stopTimes.clear();
        this.initialized = false;
        this.load();
    }

    getStop(stopId) {
        return this.stops.get(stopId);
    }

    getRoute(routeId) {
        return this.routes.get(routeId);
    }

    getTrip(tripId) {
        return this.trips.get(tripId);
    }

    getAllStops() {
        return Array.from(this.stops.values());
    }

    getStats() {
        return {
            stops: this.stops.size,
            routes: this.routes.size,
            trips: this.trips.size
        }
    }
}

export const staticDataService = new StaticDataService();
