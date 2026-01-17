import { staticDataService } from './StaticDataService.js';
import { gtfsMonitor } from './GtfsMonitor.js';

class TransitService {

    async getStopInfo(stopId, direction) {
        const stopInfo = {
            stop: null,
            upcomingTrips: [],
            alerts: [],
            warnings: [],
            lastUpdated: new Date().toISOString()
        };

        // Get static stop information
        const stop = staticDataService.getStop(stopId);
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

        // Get Real-time Trips
        const tripsFeed = gtfsMonitor.getTrips();
        const tripsStatus = gtfsMonitor.getStatus().trips;

        if (!tripsFeed) {
            if (tripsStatus.error) {
                stopInfo.warnings.push(`Real-time trip data unavailable: ${tripsStatus.error}`);
            } else {
                stopInfo.warnings.push('Real-time trip data initializing...');
            }
        } else {
            // Check staleness
            const now = Date.now();
            const dataAge = now - (tripsStatus.lastUpdate ? tripsStatus.lastUpdate.getTime() : 0);
            if (dataAge > 120000) { // 2 minutes
                stopInfo.warnings.push(`Real-time data is stale (${Math.round(dataAge / 1000)}s old)`);
            }
            stopInfo.lastUpdated = tripsStatus.lastUpdate ? tripsStatus.lastUpdate.toISOString() : stopInfo.lastUpdated;
        }

        if (tripsFeed) {
            this._processTrips(tripsFeed, stopInfo, stopId);
        }

        this._sortAndFilterTrips(stopInfo, direction);

        // Get Alerts
        const alertsFeed = gtfsMonitor.getAlerts();
        if (alertsFeed) {
            this._processAlerts(alertsFeed, stopInfo, stopId);
        } else if (gtfsMonitor.getStatus().alerts.error) {
            stopInfo.warnings.push('Real-time alerts data unavailable');
        }

        return stopInfo;
    }

    _processTrips(tripsFeed, stopInfo, stopId) {
        const now = Math.floor(Date.now() / 1000); // Current time in seconds
        let tripCount = 0;
        let stopFoundCount = 0;

        tripsFeed.entity.forEach(entity => {
            if (!entity.tripUpdate) return;
            tripCount++;

            const tripUpdate = entity.tripUpdate;
            const tripId = tripUpdate.trip?.tripId;

            if (!tripId) return;

            // Get trip details from static data
            let trip = staticDataService.getTrip(tripId);

            // Sometimes tripId in GTFS-RT doesn't match static exactly or is added dyncamically
            // We try to find it, but if not found, we might skip or try to infer.
            // For BART, they usually match.
            if (!trip) return;

            // Get Trip direction and route
            const tripDirection = trip.direction_id === "0" ? "outbound" : "inbound";
            const route = staticDataService.getRoute(trip.route_id);
            const vehicle = tripUpdate.vehicle || entity.vehicle;

            // Find stop time updates for our stop
            if (tripUpdate.stopTimeUpdate) {
                tripUpdate.stopTimeUpdate.forEach(stopTimeUpdate => {
                    if (stopTimeUpdate.stopId === stopId) {
                        stopFoundCount++;
                        const arrival = stopTimeUpdate.arrival;
                        const departure = stopTimeUpdate.departure;

                        if (arrival || departure) {
                            const time = arrival?.time || departure?.time;
                            const delay = arrival?.delay || departure?.delay || 0;

                            // Only include future arrivals
                            if (time && Number(time) > now) {
                                // Use decoding from long if needed, but JS handles this usually if not too huge
                                // protobufjs uses Long objects, but gtfs-realtime-bindings might return them as objects or numbers
                                // Safe to convert to Number if it's within safe integer range.
                                const timeNum = Number(time);

                                const scheduledTime = timeNum - delay;
                                const arrivalTime = new Date(timeNum * 1000);
                                const minutesUntilArrival = Math.round((timeNum - now) / 60);

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
    }

    _sortAndFilterTrips(stopInfo, direction) {
        // Sort by arrival time
        stopInfo.upcomingTrips.sort((a, b) =>
            new Date(a.estimatedArrival) - new Date(b.estimatedArrival)
        );

        // Filter by direction if specified
        if (direction) {
            stopInfo.upcomingTrips = stopInfo.upcomingTrips.filter(trip => {
                const routeName = (trip.routeName || '').toLowerCase();
                const headsign = (trip.headsign || '').toLowerCase();
                const routeLongName = (trip.routeLongName || '').toLowerCase();
                const dir = direction.toLowerCase();

                // Logic copied from original index.js
                if (dir === 'eastbound') {
                    return routeName.includes('n') ||
                        headsign.includes('antioch') ||
                        headsign.includes('berryessa') ||
                        headsign.includes('dublin') ||
                        headsign.includes('pittsburg');
                } else if (dir === 'westbound') {
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

    _processAlerts(alertsFeed, stopInfo, stopId) {
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
}

export const transitService = new TransitService();
