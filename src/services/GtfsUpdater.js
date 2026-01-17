import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { config } from '../config/config.js';
import { staticDataService } from './StaticDataService.js';

class GtfsUpdater {
    constructor() {
        // BART Developer License URL that often redirects or contains links
        this.bartUrl = 'https://www.bart.gov/dev/schedules/google_transit.zip';
        this.isUpdating = false;
        this.lastUpdate = null;
    }

    start() {
        // Check daily
        setInterval(() => this.checkForUpdates(), 24 * 60 * 60 * 1000);
        console.log('GTFS Updater service started (Daily checks)');
    }

    async checkForUpdates() {
        if (this.isUpdating) return;
        this.isUpdating = true;
        console.log('Checking for GTFS updates...');

        try {
            // 1. Get the actual download URL
            const downloadUrl = await this._resolveDownloadUrl(this.bartUrl);
            if (!downloadUrl) {
                throw new Error('Could not resolve GTFS download URL');
            }
            console.log(`Resolved GTFS URL: ${downloadUrl}`);

            // 2. Download the file
            const zipBuffer = await this._downloadFile(downloadUrl);

            // 3. Process the update
            await this._processUpdate(zipBuffer);

            this.lastUpdate = new Date();
            console.log('GTFS update completed successfully');

        } catch (error) {
            console.error('GTFS Update failed:', error.message);
        } finally {
            this.isUpdating = false;
        }
    }

    async _resolveDownloadUrl(initialUrl) {
        const response = await fetch(initialUrl); // standard fetch follows 3xx
        const text = await response.text();

        // Check for client-side meta refresh which BART uses
        // <meta http-equiv="refresh" content="0;url='...'" />
        const match = text.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=['"]?([^'"\s>]+)['"]?/i);

        if (match && match[1]) {
            let redirectUrl = match[1];
            // Handle relative URLs if necessary, though BART usually gives absolute
            if (redirectUrl.startsWith('/')) {
                const u = new URL(initialUrl);
                redirectUrl = `${u.protocol}//${u.host}${redirectUrl}`;
            }
            return redirectUrl;
        }

        // If it was a direct download (binary content), fetch response.url would be the final url
        // and headers content-type would be zip.
        const contentType = response.headers.get('content-type');
        if (contentType && (contentType.includes('zip') || contentType.includes('octet-stream'))) {
            return response.url;
        }

        return null;
    }

    async _downloadFile(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
        return await response.arrayBuffer();
    }

    async _processUpdate(arrayBuffer) {
        const buffer = Buffer.from(arrayBuffer);
        const zip = new AdmZip(buffer);

        // Validate zip has essential files
        if (!zip.getEntry('trips.txt') || !zip.getEntry('stops.txt')) {
            throw new Error('Invalid GTFS zip: missing required files');
        }

        // Extract to static data directory
        console.log(`Extracting to ${config.paths.staticData}...`);
        zip.extractAllTo(config.paths.staticData, true); // true = overwrite

        // Reload services
        staticDataService.reload();
    }
}

export const gtfsUpdater = new GtfsUpdater();
