// Hi-fi canvas — lays out all the polished artboards in one Design Canvas,
// threaded through the theme tweak.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "mode": "dark"
}/*EDITMODE-END*/;

function HiFiCanvas() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const W = 1320, H = 860;
  const canvasBg = t.mode === 'dark' ? 'oklch(6% 0.003 80)' : 'oklch(96% 0.005 80)';

  return (
    <>
      <DesignCanvas storageKey="cf-hifi-v1" canvasBackground={canvasBg}>
        {/* Main layout — the three rail/scope states */}
        <DCSection
          id="main"
          title="claude-fleet · hi-fi"
          subtitle="V2 brought to fidelity. Click any container chip to switch — each container has its own set of terminals (pips on the chip preview them at a glance)."
        >
          <DCArtboard id="main-container" label="A · api-tests selected · 3 terminals" width={W} height={H}>
            <HiFiApp mode={t.mode} initialCollapsed={false} initialScope="container" initialContainer="c2" />
          </DCArtboard>
          <DCArtboard id="main-docs" label="A2 · docs-refactor selected · 2 terminals" width={W} height={H}>
            <HiFiApp mode={t.mode} initialCollapsed={false} initialScope="container" initialContainer="c1" />
          </DCArtboard>
          <DCArtboard id="main-design" label="A3 · design-system selected · 1 terminal" width={W} height={H}>
            <HiFiApp mode={t.mode} initialCollapsed={false} initialScope="container" initialContainer="c3" />
          </DCArtboard>
          <DCArtboard id="main-fleet" label="B · Fleet scope" width={W} height={H}>
            <HiFiApp mode={t.mode} initialCollapsed={false} initialScope="fleet" initialContainer="c2" />
          </DCArtboard>
          <DCArtboard id="main-collapsed" label="C · Collapsed rail" width={W} height={H}>
            <HiFiApp mode={t.mode} initialCollapsed={true} initialScope="container" initialContainer="c2" />
          </DCArtboard>
        </DCSection>

        {/* Screens — modals & overlays the SPEC needs */}
        <DCSection
          id="screens"
          title="Modals & overlays"
          subtitle="The flows beyond the main view, in context."
        >
          <DCArtboard id="screen-create" label="D · New container" width={W} height={H}>
            <CreateContainerScreen mode={t.mode} />
          </DCArtboard>
          <DCArtboard id="screen-profiles" label="E · Profiles" width={W} height={H}>
            <ProfilesScreen mode={t.mode} />
          </DCArtboard>
          <DCArtboard id="screen-drop" label="F · Drop overlay + toast" width={W} height={H}>
            <DropScreen mode={t.mode} />
          </DCArtboard>
          <DCArtboard id="screen-resume" label="G · Resume (container gone)" width={W} height={H}>
            <ResumeScreen mode={t.mode} />
          </DCArtboard>
          <DCArtboard id="screen-empty" label="H · Daemon down · first run" width={W} height={H}>
            <EmptyScreen mode={t.mode} />
          </DCArtboard>
          <DCArtboard id="screen-terminal-settings" label="I · Terminal settings" width={W} height={H}>
            <HiFiApp mode={t.mode} initialModal="terminal-settings" />
          </DCArtboard>
          <DCArtboard id="screen-close-terminal" label="J · Close terminal (with mirror)" width={W} height={H}>
            <HiFiApp mode={t.mode} initialModal="close-terminal" />
          </DCArtboard>
        </DCSection>
      </DesignCanvas>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme" />
        <TweakRadio
          label="Mode"
          value={t.mode}
          options={['dark', 'light']}
          onChange={(v) => setTweak('mode', v)}
        />
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<HiFiCanvas />);
