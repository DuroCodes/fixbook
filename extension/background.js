const FIXBOOK = "https://fixbook-phi.vercel.app";

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url?.includes("facebook.com/marketplace/item")) return;
  chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeListing });
});

const scrapeListing = async () => {
  const text = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
  const cleanTitle = (value) =>
    value
      .replace(/^\(\d+\+?\)\s*/, "")
      .replace(/^Marketplace\s*[-–—]\s*/i, "")
      .replace(/\s*[|｜]\s*Facebook\b.*/i, "")
      .replace(/\s+/g, " ")
      .trim();

  const headings = [...document.querySelectorAll("h1")].filter((el) => {
    const label = text(el);
    return label && !/^(search results|marketplace)$/i.test(label);
  });
  const panel = headings
    .map((el) => {
      let node = el;
      for (let depth = 0; node && node !== document.body && depth < 25; depth++) {
        if (/about this (vehicle|item|home)|seller's description/i.test(node.innerText || "")) {
          return { el, root: node, size: node.innerText.length };
        }
        node = node.parentElement;
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.size - b.size)[0];

  const root = panel?.root || document.querySelector('[role="main"]') || document.body;
  const title = cleanTitle(text(panel?.el)) || cleanTitle(document.title);
  const lines = (root.innerText || "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const listed =
    lines.find((line) => /^listed\s+.+\s+in\s+.+/i.test(line)) || "Listed on Facebook Marketplace";

  let price = "";
  let priceNode = panel?.el?.parentElement;
  while (priceNode && priceNode !== root.parentElement) {
    const matches = text(priceNode).match(/(?:CA|US|AU|NZ)?\s?[$£€]\s?[\d,]+(?:\.\d{2})?|\bFree\b/gi);
    if (matches?.length && text(priceNode).length < 140) {
      price = matches.length > 1 ? `${matches[0]} ~~${matches[1]}~~` : matches[0];
      break;
    }
    priceNode = priceNode.parentElement;
  }

  const sectionText = (heading, stop) => {
    let node = heading;
    while (node?.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement;
      if ([...parent.querySelectorAll("h2")].some((el) => el !== heading && stop.test(text(el)))) break;
      node = parent;
    }
    return (node?.innerText || "")
      .replace(heading?.innerText || "", "")
      .replace(/\s*see (more|less)\s*/gi, " ")
      .replace(/[^\n]*location is approximate\s*/gi, "")
      .trim();
  };

  const labelsUnder = (heading, stop) => {
    let node = heading?.parentElement;
    let labels = [];
    while (node && node !== document.body) {
      if ([...node.querySelectorAll("h2")].some((el) => stop.test(text(el)) && el !== heading)) break;
      labels = [...node.querySelectorAll("span[dir='auto']")]
        .filter((span) => !span.querySelector("span") && !heading.contains(span))
        .map((span) => text(span))
        .filter((value) => value && value.length < 160 && !/^about this/i.test(value) && !stop.test(value));
      node = node.parentElement;
    }
    return labels;
  };

  const about = [...root.querySelectorAll("h2")].find((el) =>
    /^about this (vehicle|item|home)$/i.test(text(el)),
  );
  const details = about ? labelsUnder(about, /seller/i) : [];

  const seller = [...root.querySelectorAll("h2")].find((el) => /seller'?s description/i.test(text(el)));
  const description = seller ? sectionText(seller, /seller information|seller details|^ad$/i) : "";

  let imageRoot = root;
  for (let depth = 0; depth < 8 && imageRoot.parentElement; depth++) {
    if (imageRoot.querySelector("img[alt*='Product photo' i]")) break;
    imageRoot = imageRoot.parentElement;
  }
  const images = [
    ...new Set(
      [...imageRoot.querySelectorAll("img")]
        .filter((img) => /product photo/i.test(img.alt || ""))
        .map((img) => img.currentSrc || img.src)
        .filter((src) => /^https:\/\//.test(src) && !/\/t45\.1600|\/t39\.84726/.test(src)),
    ),
  ].slice(0, 4);

  const id = window.location.href.match(/marketplace\/item\/(\d+)/)?.[1];
  if (!id) {
    alert("Could not find a Marketplace item id in this URL.");
    return;
  }

  const copy = (text) => {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.cssText = "position:fixed;opacity:0";
    document.body.append(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  };

  chrome.runtime.sendMessage(
    {
      type: "fixbook:createListing",
      payload: {
        id,
        title,
        price: price || "Check Link",
        listed,
        details,
        description: description || "No description available.",
        images: [...new Set(images)].slice(0, 10),
      },
    },
    (response) => {
      if (chrome.runtime.lastError) {
        alert(`Fixbook error: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (!response?.ok) {
        alert(`Fixbook error: ${response?.error || "Unknown error"}`);
        return;
      }
      const copied = copy(response.url);
      alert(copied ? `Copied:\n${response.url}` : `Copy this link:\n${response.url}`);
    },
  );
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "fixbook:createListing") return;

  (async () => {
    try {
      const response = await fetch(`${FIXBOOK}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message.payload),
      });

      if (!response.ok) {
        sendResponse({
          ok: false,
          error: `Fixbook API error (${response.status}): ${await response.text()}`,
        });
        return;
      }

      const json = await response.json();
      const id = json.id || message.payload?.id;
      sendResponse({
        ok: true,
        url: `${FIXBOOK}/marketplace/item/${encodeURIComponent(id)}`,
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});
