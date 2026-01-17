import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { config } from '../config/config.js';

class GtfsMonitor {
    constructor() {
        this.tripsFeed = null;
        this.alertsFeed = null;
        this.lastTripsUpdate = null;
        this.lastAlertsUpdate = null;
        this.tripsError = null;
        this.alertsError = null;

        // Status tracking
        this.isPolling = false;
        this.stats = {
            tripUpdates: 0,
            tripErrors: 0,
            alertUpdates: 0,
            alertErrors: 0
        };
    }

    start() {
        if (this.isPolling) return;
        this.isPolling = true;

        // Initial fetch
        this.updateTrips();
        this.updateAlerts();

        // Start polling intervals
        setInterval(() => this.updateTrips(), config.refreshInterval);
        setInterval(() => this.updateAlerts(), config.refreshInterval * 2); // Alerts change less often

        console.log('GTFS Real-time monitor started');
    }

    async fetchFeed(url, type) {
        const retries = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'bart-proxy/1.0.0 (https://github.com/filbot/bart-proxy)',
                        'Accept': 'application/x-protobuf, application/octet-stream',
                        'Connection': 'keep-alive'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    // If 500/502/503/504, it might be temporary.
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const buffer = await response.arrayBuffer();
                const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
                    new Uint8Array(buffer)
                );

                return feed;

            } catch (error) {
                lastError = error;
                const isLastAttempt = attempt === retries;

                // Log warning but don't spam if it's just a transient issue that resolves
                console.warn(`Attempt ${attempt}/${retries} failed for ${type}: ${error.message}`);

                if (!isLastAttempt) {
                    // Exponential backoff: 1s, 2s, 4s
                    const delay = 1000 * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError;
    }

    async updateTrips() {
        try {
            const feed = await this.fetchFeed(config.feeds.trips, 'trips');
            this.tripsFeed = feed;
            this.lastTripsUpdate = new Date();
            this.tripsError = null;
            this.stats.tripUpdates++;
            // console.log(`Trips updated at ${this.lastTripsUpdate.toISOString()}`);
        } catch (error) {
            this.tripsError = error;
            this.stats.tripErrors++;
            console.error(`Failed to update trips feed: ${error.message}`);
            // We keep the stale data logic handled by the getter (checking timestamps)
        }
    }

    async updateAlerts() {
        try {
            const feed = await this.fetchFeed(config.feeds.alerts, 'alerts');
            this.alertsFeed = feed;
            this.lastAlertsUpdate = new Date();
            this.alertsError = null;
            this.stats.alertUpdates++;
        } catch (error) {
            this.alertsError = error;
            this.stats.alertErrors++;
            console.error(`Failed to update alerts feed: ${error.message}`);
        }
    }

    getTrips() {
        // Return null if no data ever loaded
        if (!this.tripsFeed) return null;

        // Optional: Return null if data is too stale (e.g. > 5 mins)
        // For now we return what we have but maybe add a 'stale' flag in the consumer
        return this.tripsFeed;
    }

    getAlerts() {
        return this.alertsFeed;
    }

    getStatus() {
        return {
            trips: {
                lastUpdate: this.lastTripsUpdate,
                hasData: !!this.tripsFeed,
                error: this.tripsError ? this.tripsError.message : null
            },
            alerts: {
                lastUpdate: this.lastAlertsUpdate,
                hasData: !!this.alertsFeed,
                error: this.alertsError ? this.alertsError.message : null
            },
            stats: this.stats
        };
    }
}

export const gtfsMonitor = new GtfsMonitor();
