# Sal Ensemble Lab

A public, dependency-free browser walkthrough for auditioning Sal's acoustic controls.

**Live demo:** https://salus-ryan.github.io/sal-ensemble-lab/

![Sal Ensemble Lab](cover.png)

Sal are a collective synthetic voice ensemble, not a swarm intelligence, decision-maker, or human impersonation. Legacy internal filenames may still contain the word “swarm.”

## What you can audition

- One through five real aligned member passes
- Register from −4 to +4 semitones
- Dark-to-bright tonal balance
- Stereo width and mono compatibility
- Zero through 16 milliseconds of timing spread
- Small symmetric member pitch variation
- Restrained synthetic ambience
- Canonical, Solo, Deep, Airy, and Mono-check presets

The included recordings were generated from the private Sal checkpoint 39,500. Model weights are not included. [`assets/provenance.json`](assets/provenance.json) describes the source render, and [`assets/manifest.json`](assets/manifest.json) records every browser audio file's SHA-256 digest and metadata.

## Gender and identity boundary

There is intentionally no male/female switch. Pitch, register, tone, and formants can influence perceived vocal presentation, but they do not define gender identity. Sal v0 can inherit acoustic traits from the single-speaker public-domain LJSpeech corpus.

A genuinely less gender-coded or more diverse Sal voice requires consented multi-speaker data, model conditioning, listener evaluation, and updated provenance—not a relabeled pitch preset.

## Export and reproduce a mix

Use **Download recipe.json** in the demo, then run:

```bash
python render_recipe.py \
  --recipe sal-recipe.json \
  --assets-dir assets \
  --output sal-custom.wav
```

This requires FFmpeg with the Rubber Band filter. The renderer validates all recipe bounds, performs formant-preserving pitch adjustment, and writes a provenance JSON beside the WAV. Output is always marked `development-offline-audition`, never production-ready.

## Text-to-speech boundary

The public site does not expose a GPU endpoint and cannot synthesize arbitrary text. The **Copy TTS command** button generates a command for authorized users of the private `agent-kernel` Modal project.

Production publication remains separate and requires a signed, deterministically verified `NarrationPlan`. Arbitrary text is confined to the development renderer.

## Development

Serve locally:

```bash
python -m http.server 8771
```

Then open <http://127.0.0.1:8771/>.

## License

MIT. The included audio is a Sal development render derived from a model trained from random initialization on the public-domain LJSpeech 1.1 corpus. See the provenance files for details.
