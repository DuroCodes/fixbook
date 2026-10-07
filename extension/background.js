const FIXBOOK = "https://fixbook-phi.vercel.app";

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url?.includes("facebook.com/marketplace/item")) return;
  chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeListing });
});

const scrapeListing = async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cleanTitle = (value) =>
    value
      .replace(/^\(\d+\+?\)\s*/, "")
      .replace(/^Marketplace\s*[-–—]\s*/i, "")
      .replace(/\s*\|\s*Facebook$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  const linesOf = (root) =>
    (root?.innerText || "")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  const section = (lines, start, end) => {
    const from = lines.findIndex((line) => start.test(line));
    if (from === -1) return [];
    const to = lines.findIndex((line, index) => index > from && end.test(line));
    return lines.slice(from + 1, to === -1 ? from + 16 : to);
  };

  const h1 = [...document.querySelectorAll("h1")].find((el) => {
    const text = el.innerText.trim();
    if (!text || text.length > 180 || /^marketplace$/i.test(text)) return false;
    let node = el;
    for (let depth = 0; node && depth < 8; depth++) {
      if (/listed\s+.+\s+in\s+/i.test(node.innerText || "")) return true;
      node = node.parentElement;
    }
    return false;
  });

  let listingRoot = h1 || document.querySelector('[role="main"]');
  if (h1) {
    let node = h1;
    while (node && node !== document.body) {
      if (/listed\s+.+\s+in\s+|about this (vehicle|item)/i.test(node.innerText || "")) {
        listingRoot = node;
        break;
      }
      node = node.parentElement;
    }
  }

  const seeMore = [...(listingRoot?.querySelectorAll("button, [role='button']") || [])].filter((el) =>
    /^see more$/i.test((el.innerText || el.getAttribute("aria-label") || "").trim()),
  );
  for (const button of seeMore) button.click();
  if (seeMore.length) await wait(200);

  const lines = linesOf(listingRoot);
  const title = cleanTitle(h1?.innerText || "") || cleanTitle(document.title);
  const listed =
    lines.find((line) => /^listed\s+.+\s+in\s+.+/i.test(line)) || "Listed on Facebook Marketplace";
  const listedAt = lines.indexOf(listed);
  const priceMatch = lines
    .slice(0, listedAt === -1 ? 8 : listedAt)
    .map((line) => line.match(/(?:CA|US|AU|NZ)?\s?[$£€]\s?[\d,]+(?:\.\d{2})?|\bFree\b/gi))
    .find(Boolean);
  const price = priceMatch
    ? priceMatch.length > 1
      ? `${priceMatch[0]} ~~${priceMatch[1]}~~`
      : priceMatch[0]
    : "";

  const noise = /^(see more|see less|message|share|save|follow)$/i;
  const rawDetails = section(
    lines,
    /^about this (vehicle|item|home)$/i,
    /^(seller'?s description|description|location is approximate|sponsored|today'?s picks)$/i,
  ).filter((line) => !noise.test(line));
  const details = [];
  for (let i = 0; i < rawDetails.length; i++) {
    const line = rawDetails[i];
    if (/:$/.test(line) && rawDetails[i + 1] && !/:$/.test(rawDetails[i + 1])) {
      details.push(`${line} ${rawDetails[++i]}`);
    } else {
      details.push(line);
    }
  }

  let description = section(
    lines,
    /^seller'?s description$/i,
    /^(location is approximate|sponsored|today'?s picks|about this (vehicle|item|home))$/i,
  )
    .filter((line) => !noise.test(line))
    .join("\n");
  if (!description && listedAt !== -1) {
    description = lines
      .slice(listedAt + 1, listedAt + 12)
      .filter((line) => !noise.test(line) && !details.includes(line) && line.length > 40)
      .join("\n");
  }

  const h1Box = h1?.getBoundingClientRect() || { top: 0, left: 800, right: 1200, bottom: 80 };
  const images = [
    ...new Set(
      [...document.querySelectorAll("img")]
        .filter((img) => {
          const src = img.currentSrc || img.src || "";
          const box = img.getBoundingClientRect();
          const leftOfTitle = box.right <= h1Box.left + 80;
          const aboveTitle = box.bottom <= h1Box.top + 40 && box.left < h1Box.right;
          const nearTitle = box.top < h1Box.bottom + 500 && box.bottom > h1Box.top - 700;
          return (
            /^https:\/\//.test(src) &&
            !/\/t45\./.test(src) &&
            !img.closest('[aria-label*="Sponsored" i]') &&
            box.width >= 120 &&
            box.height >= 120 &&
            nearTitle &&
            (leftOfTitle || aboveTitle)
          );
        })
        .map((img) => img.currentSrc || img.src),
    ),
  ].slice(0, 10);

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
