define(class extends PollingAction {
    async onDialRotate({payload: {settings, ticks}}) {
        if (!this.sonos.isConnected()) return;
        const step = parseInt(settings.volumeStep) || 2;
        const {CurrentVolume: volume} = await this.sonos.getGroupVolume();
        const newVolume = Math.min(100, Math.max(0, parseInt(volume) + ticks * step));
        await this.sonos.setGroupVolume(newVolume);
        this.updateFeedback(newVolume, false);
    }

    async onDialDown() {
        if (!this.sonos.isConnected()) return;
        const {CurrentMute: muted} = await this.sonos.getGroupMute();
        await this.sonos.setGroupMute(muted === '1' ? 0 : 1);
    }

    async onTouchTap() {
        if (!this.sonos.isConnected()) return;
        const {CurrentMute: muted} = await this.sonos.getGroupMute();
        await this.sonos.setGroupMute(muted === '1' ? 0 : 1);
    }

    async refresh() {
        const {CurrentVolume: volume} = await this.sonos.getGroupVolume();
        const {CurrentMute: muted} = await this.sonos.getGroupMute();
        this.updateFeedback(parseInt(volume), muted === '1');
    }

    updateFeedback(volume, muted) {
        this.streamDeck.setFeedback({
            title: muted ? 'Muted' : 'Volume',
            value: muted ? 'OFF' : `${volume}%`,
            indicator: {value: muted ? 0 : volume, enabled: !muted}
        }, this.context);
    }
});
