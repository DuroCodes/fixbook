# fixbook

facebook marketplace listings, with a discord preview that actually shows the car.

this is mainly designed for cars, but other listings *should* work as well.

## install

load the extension in chrome:

1. open `chrome://extensions`
2. turn on developer mode
3. **load unpacked** and choose the `extension` folder

## dev

you need [bun](https://bun.sh) and the [vercel cli](https://vercel.com/docs/cli).

```bash
bun install
```

add a `.env` with a postgres url. this project uses [neon](https://neon.tech).

```bash
DATABASE_URL="postgres://..."
```

```bash
vc dev
```

open [localhost:3000](http://localhost:3000).

the extension talks to `https://fixbook-phi.vercel.app`. point `FIXBOOK` in `extension/background.js` and the host permission in `extension/manifest.json` somewhere else if you need to.

## links

swap `facebook` in a marketplace url for the deployed host:

```
https://www.facebook.com/marketplace/item/123
https://fixbook-phi.vercel.app/marketplace/item/123
```

or open the listing and click the extension, it copies the link.

listings stick around for a month, since facebok marketplace listings usually don't last that long.
