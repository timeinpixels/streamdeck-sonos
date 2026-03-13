class Sonos {
    static BROWSE_TYPE = {
        ARTISTS: 'A:ARTIST',
        ARTIST_ALBUMS: 'A:ALBUMARTIST',
        ALBUMS: 'A:ALBUM',
        GENRES: 'A:GENRE',
        COMPOSERS: 'A:COMPOSER',
        TRACKS: 'A:TRACKS',
        PLAYLISTS: 'A:PLAYLISTS',
        SHARES: 'S:',
        SONOS_PLAYLISTS: 'SQ:',
        CATEGORIES: 'A:',
        SONOS_FAVORITES: 'FV:2',
        RADIO_STATIONS: 'R:0/0',
        RADIO_SHOWS: 'R:0/1'
    }

    static async discover(knownHost) {
        //find any one Sonos device on the network
        let firstIp = null;

        //try the known host first
        if (knownHost && await Sonos.probe(knownHost)) {
            firstIp = knownHost;
        }

        //scan subnets if needed
        if (!firstIp) {
            const subnets = new Set();
            if (knownHost) {
                const parts = knownHost.split('.');
                if (parts.length === 4) subnets.add(parts.slice(0, 3).join('.'));
            }
            for (const s of ['192.168.1', '192.168.0', '192.168.2', '10.0.0', '10.0.1']) {
                subnets.add(s);
            }

            for (const subnet of subnets) {
                const promises = [];
                for (let i = 1; i <= 254; i++) {
                    promises.push(Sonos.probe(`${subnet}.${i}`));
                }
                const results = await Promise.allSettled(promises);
                const found = results.find(r => r.status === 'fulfilled' && r.value);
                if (found) {
                    firstIp = found.value.ip;
                    break;
                }
            }
        }

        if (!firstIp) return [];

        //use zone group topology to get rooms (not individual speakers/satellites)
        try {
            const sonos = new Sonos();
            sonos.connect(firstIp, 1400);
            const zoneState = await sonos.getZoneGroupState();

            const speakers = [];
            zoneState.querySelectorAll('ZoneGroup').forEach(group => {
                const coordinatorUUID = group.getAttribute('Coordinator');
                //select only direct ZoneGroupMember children (not Satellite elements)
                [...group.children].forEach(child => {
                    if (child.nodeName !== 'ZoneGroupMember') return;
                    if (child.getAttribute('Invisible') === '1') return;
                    const location = child.getAttribute('Location');
                    const name = child.getAttribute('ZoneName');
                    if (!location || !name) return;
                    const match = location.match(/\/\/([^:]+):/);
                    if (match) {
                        speakers.push({ip: match[1], name});
                    }
                });
            });

            speakers.sort((a, b) => a.name.localeCompare(b.name));
            return speakers;
        } catch {
            //fallback to just the found speaker
            const info = await Sonos.probe(firstIp);
            return info ? [info] : [];
        }
    }

    static async probe(ip) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        try {
            const res = await fetch(`http://${ip}:1400/status/zp`, {signal: controller.signal});
            clearTimeout(timer);
            return res.ok;
        } catch {
            clearTimeout(timer);
            return false;
        }
    }

    constructor() {
        this.avTransport = new SonosService(this, 'AVTransport', 'MediaRenderer/AVTransport');
        this.renderingControl = new SonosService(this, 'RenderingControl', 'MediaRenderer/RenderingControl');
        this.groupRenderingControl = new SonosService(this, 'GroupRenderingControl', 'MediaRenderer/GroupRenderingControl');
        this.zoneGroupTopology = new SonosService(this, 'ZoneGroupTopology');
        this.contentDirectory = new SonosService(this, 'ContentDirectory', 'MediaServer/ContentDirectory');
    }

    connect(host, port) {
        this.host = host;
        this.port = port;
    }

    isConnected() {
        return this.host && this.port;
    }

    async getTransportInfo() {
        return this.avTransport.execute('GetTransportInfo');
    }

    async play() {
        return this.avTransport.execute('Play', {Speed: 1});
    }

    async pause() {
        return this.avTransport.execute('Pause');
    }

    async next() {
        return this.avTransport.execute('Next');
    }

    async previous() {
        return this.avTransport.execute('Previous');
    }

    async getTransportSettings() {
        return this.avTransport.execute('GetTransportSettings');
    }

    async setPlayMode(playMode) {
        return this.avTransport.execute('SetPlayMode', {NewPlayMode: playMode});
    }

    async setLocalTransport(prefix, suffix) {
        const zoneGroupState = await this.getZoneGroupState();
        const coordinator = zoneGroupState.querySelector('ZoneGroup').getAttribute('Coordinator');
        return this.setAVTransportURI(`${prefix}:${coordinator}${suffix || ''}`);
    }

    async setAVTransportURI(uri, metadata) {
        return this.avTransport.execute('SetAVTransportURI', {CurrentURI: uri, CurrentURIMetaData: metadata || ''});
    }

    async getPositionInfo() {
        return this.avTransport.execute('GetPositionInfo');
    }

    async getZoneGroupState() {
        //return from cache if we already fetched the zones
        if (this.zoneGroupState) {
            return Promise.resolve(this.zoneGroupState);
        }

        const {ZoneGroupState: state} = await this.zoneGroupTopology.execute('GetZoneGroupState');
        const zoneGroupState = new DOMParser().parseFromString(state, 'text/xml');
        this.zoneGroupState = zoneGroupState;
        return zoneGroupState;
    }

    async getMute() {
        return this.renderingControl.execute('GetMute', {Channel: 'Master'});
    }

    async setMute(mute) {
        return this.renderingControl.execute('SetMute', {Channel: 'Master', DesiredMute: mute ? '1' : '0'});
    }

    async getVolume() {
        return this.renderingControl.execute('GetVolume', {Channel: 'Master'});
    }

    async setVolume(volume) {
        return this.renderingControl.execute('SetVolume', {Channel: 'Master', DesiredVolume: volume});
    }

    async getGroupVolume() {
        return this.groupRenderingControl.execute('GetGroupVolume');
    }

    async setGroupVolume(volume) {
        return this.groupRenderingControl.execute('SetGroupVolume', {DesiredVolume: volume});
    }

    async getGroupMute() {
        return this.groupRenderingControl.execute('GetGroupMute');
    }

    async setGroupMute(mute) {
        return this.groupRenderingControl.execute('SetGroupMute', {DesiredMute: mute ? '1' : '0'});
    }

    async setServiceURI(uri, metadata) {
        if (uri.startsWith('x-sonosapi-stream:')) {
            return this.setAVTransportURI(uri, metadata);
        }

        //add playlist to end of queue
        const {FirstTrackNumberEnqueued: trackNr} = await this.addURIToQueue(uri, metadata);
        if (!trackNr)
            throw new Error(`Failed to add URI "${uri}" to queue`);

        //switch source to queue
        await this.setLocalTransport('x-rincon-queue', '#0');

        //set active track to the first in the playlist
        return this.seek('TRACK_NR', trackNr);
    }

    async seek(unit, target) {
        return this.avTransport.execute('Seek', {Unit: unit, Target: target});
    }

    async addURIToQueue(uri, metadata, position, next) {
        return this.avTransport.execute('AddURIToQueue', {
            EnqueuedURI: uri,
            EnqueuedURIMetaData: metadata,
            DesiredFirstTrackNumberEnqueued: position || 0,
            EnqueueAsNext: next ? '1' : '0'
        });
    }

    async browse(type, term, categories, start, count) {
        let objectId = type;
        if (categories)
            objectId += '/' + categories.map(c => encodeURIComponent(c)).join('/')
        if (term)
            objectId += ':' + encodeURIComponent(type);

        const {Result: result} = await this.contentDirectory.execute('Browse', {
            ObjectID: objectId,
            BrowseFlag: 'BrowseDirectChildren',
            Filter: '*',
            StartingIndex: start || '0',
            RequestedCount: count || '100',
            SortCriteria: ''
        });

        const items = new DOMParser().parseFromString(result, 'text/xml');
        return [...items.querySelectorAll('item')].map(i => ({
            title: this.getElementText(i, 'dc:title'),
            uri: this.getElementText(i, 'res'),
            metadata: this.getElementText(i, 'r:resMD'),
            albumArtURI: this.getAlbumArtURI(i)
        }));
    }

    getElementText(xml, elementName) {
        const elements = xml.getElementsByTagName(elementName)
        return elements.length && elements[0].childNodes.length ?
            elements[0].childNodes[0].nodeValue : null;
    }

    getAlbumArtURI(metadata) {
        let albumArtURI = this.getElementText(metadata, 'upnp:albumArtURI');
        if (albumArtURI && !albumArtURI.startsWith('http'))
            albumArtURI = `http://${this.host}:1400${albumArtURI}`;
        return albumArtURI;
    }
}

class SonosService {
    constructor(sonos, name, baseUrl) {
        this.sonos = sonos;
        this.name = name;
        this.baseUrl = baseUrl || name;
    }

    async execute(action, params) {
        if (!this.sonos.isConnected())
            throw new Error('Not connected to sonos');

        params = params || {};
        params.InstanceID = params.InstanceID || 0;

        const url = `http://${this.sonos.host}:${this.sonos.port}/${this.baseUrl}/Control`;
        const soapAction = `"urn:schemas-upnp-org:service:${this.name}:1#${action}"`;
        const xmlParams = Object.keys(params).map((key) => `<${key}>${this.escape(params[key])}</${key}>`).join('');
        const request = `<?xml version="1.0" encoding="utf-8"?>
            <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
                <s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${this.name}:1">${xmlParams}</u:${action}></s:Body>
            </s:Envelope>`

        const data = await fetch(url, {
            method: 'POST',
            headers: {
                SOAPAction: soapAction,
                'Content-type': 'text/xml; charset=utf8'
            },
            body: request
        });
        const responseText = await data.text();
        if (!data.ok)
            throw new Error(responseText);

        const responseDocument = new DOMParser().parseFromString(responseText, 'text/xml');
        const response = {};
        responseDocument.querySelectorAll('Body>* *').forEach((node) =>
            response[node.nodeName] = node.textContent
        );
        return response;
    }

    escape(txt) {
        return txt.toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
}

class MusicService {
    static URI_TYPE = {
        album: {
            prefix: 'x-rincon-cpcontainer:1004206c',
            key: '00040000',
            class: 'object.container.album.musicAlbum'
        },
        episode: {
            prefix: '',
            key: '00032020',
            class: 'object.item.audioItem.musicTrack'
        },
        track: {
            prefix: '',
            key: '00032020',
            class: 'object.item.audioItem.musicTrack'
        },
        show: {
            prefix: 'x-rincon-cpcontainer:1006206c',
            key: '1006206c',
            class: 'object.container.playlistContainer'
        },
        song: {
            prefix: '',
            key: '10032020',
            class: 'object.item.audioItem.musicTrack'
        },
        playlist: {
            prefix: 'x-rincon-cpcontainer:1006206c',
            key: '1006206c',
            class: 'object.container.playlistContainer'
        },
        radio: {
            prefix: 'x-sonosapi-stream:',
            key: 'F00092020',
            class: 'object.item.audioItem.audioBroadcast'
        }
    }

    static FACTORIES = [
        (uri) => {
            const m = uri.match(/spotify.*[:/](album|episode|playlist|show|track)[:/](\w+)/);
            return m ? new MusicService(2311, m[1], `spotify:${m[1]}:${m[2]}`) : null;
        },
        (uri) => {
            const m = uri.match(/https:\/\/tidal.*[:/](album|track|playlist)[:/]([\w-]+)/);
            return m ? new MusicService(44551, m[1], `${m[1]}/${m[2]}`) : null;
        },
        (uri) => {
            const m = uri.match(/https:\/\/www.deezer.*[:/](album|track|playlist)[:/]([\w-]+)/);
            return m ? new MusicService(519, m[1], `${m[1]}-${m[2]}`) : null;
        },
        (uri) => {
            const m = uri.match(/https:\/\/music\.apple\.com\/\w+\/(album|playlist)\/[^/]+\/(?:pl\.)?([-a-zA-Z0-9]+)(?:\?i=(\d+))?/);
            if (!m) return null;

            const type = m[3] ? 'song' : m[1];
            const id = m[3] || m[2];
            return new MusicService(52231, type, `${type}:${id}`);
        },
        (uri) => {
            const m = uri.match(/https:\/\/tunein.com\/(radio)\/.*(s\d+)/);
            return m ? new MusicService(65031, m[1], m[2], 254) : null;
        }
    ]

    static parse(uri) {
        for (const factory of MusicService.FACTORIES) {
            const service = factory(uri);
            if (service) return service;
        }
    }

    constructor(serviceId, type, uri, broadcastId) {
        this.serviceId = serviceId;
        this.type = MusicService.URI_TYPE[type];
        this.encodedUri = encodeURIComponent(uri);
        this.broadcastId = broadcastId;
    }

    get metadata() {
        return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
            <item id="${this.type.key}${this.encodedUri}" restricted="true">
                <dc:title>Stream Deck</dc:title><upnp:class>${this.type.class}</upnp:class>
                <desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON${this.serviceId}_</desc>
            </item>
        </DIDL-Lite>`;
    }

    get uri() {
        return this.type.prefix + this.encodedUri + (this.broadcastId ? `?sid=${this.broadcastId}` : '');
    }

}
