# OnePhone website

Static English landing page for judges and potential campaign operators, live at https://onephone.vercel.app/. Its sample eligibility states are explicitly simulated; this is not a wallet-connected product demo.

Preview locally from this directory with `python -m http.server 4173`, then open `http://localhost:4173`.

For Vercel, import `iaqool/1phone`, set **Root Directory** to `website`, select the **Other** framework preset, and leave Build Command empty. The site has no server, secrets or environment variables. This directory can be deployed independently from the Android app and Anchor program.
