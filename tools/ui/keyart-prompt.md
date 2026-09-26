# Image prompts for the loading screen and main menu (docs/ui.md)

Generated with Codex imagegen:

    codex exec --skip-git-repo-check -C <dir> "Use the imagegen skill (built-in image_gen tool) to generate ONE image: <prompt>. After generating, copy the resulting PNG to <path> and print its final path."

## Key art fallback (docs/ui.md 3.3, only if the in-engine render does not work)

The key art is an in-engine render (tools/ui/keyart.ts). Use this prompt only as a fallback:

> A calm, naturalistic, photorealistic game key art at 16:9: a restored 1960s two-tone split-window microbus in sea-green and cream parked at the end of a weathered wooden pier at golden hour, sun low over the Pacific to the left, soft haze, gentle sea, pier railings and lamp posts receding, small beach town with palms far behind. Soft natural color grading, NOT oversaturated, no lens flare streaks, no text, no people, no props that are not a pier. Composition: car in the right third, calm empty sky and sea in the left half for UI.

## Style mockups (docs/img/ui-mockup-*.jpg)

Desktop:

> A high-fidelity UI mockup screenshot of the main menu of a browser racing game called "BULLI DRIVE", desktop 16:10 at 1440x900. Background: a realistic, calm, naturalistic 3D game render (PBR, not oversaturated, soft haze) of a restored 1960s two-tone split-window microbus in sea-green and cream parked on a weathered wooden pier at golden-hour sunset, ocean and a small coastal town with palm trees behind, subtle depth of field. UI as a restrained overlay: left side a translucent dark glass panel (charcoal with slight warm tint, 12px radius, thin 1px light border) containing: small wordmark "BULLI DRIVE" set in a clean condensed sans-serif with wide letterspacing in warm off-white, a name text field "Your name", three mode cards stacked (PARTY - coins, powerups, bumping; FREE ROAM - just cruise the bay; RACE - 6 tracks, lobby, bots) with the selected one outlined in a muted amber accent, a large amber pill button "DRIVE" with a thin progress underline. Bottom center: a car carousel with 5 small realistic car thumbnails (microbus, beetle, pickup, 356 sports coupe, 181 utility car) with left/right arrows, under the selected car three thin stat bars labeled Top speed, Acceleration, Weight. Right side: a vertical row of 8 round paint swatches in classic muted car colors. Top right: small icon buttons for settings (gear) and sound. Bottom left tiny text "WASD drive · SPACE drift · SHIFT boost". Typography: modern condensed sans, high contrast, generous spacing. Mood: premium, quiet, racing-game showroom elegance, no cartoon elements, no neon, no logos of real brands

Phone (portrait):

> A high-fidelity UI mockup screenshot of the main menu of a mobile browser racing game called "BULLI DRIVE", portrait phone screen 390x844, rendered tall portrait. Top 55% of the screen: a realistic, calm, naturalistic 3D game render (PBR, not oversaturated, soft haze) of a restored 1960s split-window microbus in sea-green and cream parked on a wooden pier at golden-hour sunset with the ocean behind, the car centered and large. Small wordmark "BULLI DRIVE" at the top in a clean condensed sans-serif with wide letterspacing in warm off-white, a gear icon top right. Over the lower part of the car image: car name "Samba Bus" with left/right chevron arrows and a row of 5 small dots, three thin stat bars (Top speed, Acceleration, Weight). Bottom 45%: a translucent dark charcoal glass sheet with rounded top corners containing: a row of 8 round paint swatches (classic muted car colors), a name field "Your name", a segmented control with three options PARTY | FREE ROAM | RACE (PARTY selected in muted amber) and one line of description under it, and at the very bottom in the thumb zone a full-width amber pill button "DRIVE" with a thin loading progress line. Tiny footer text "Stick steer · AUTO gas · DRIFT · BOOST". Typography: modern condensed sans, high contrast, generous touch targets. Mood: premium, quiet, racing-game showroom elegance, no cartoon elements, no neon, no logos of real brands
