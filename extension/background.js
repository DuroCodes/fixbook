const FIXBOOK = "https://fixbook-seven.vercel.app";

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url?.includes("facebook.com/marketplace/item")) return;
  chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeListing });
});

const scrapeListing = async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const parentsUp = (node, levels) => {
    let current = node;
    for (let i = 0; i < levels && current; i++) current = current.parentElement;
    return current;
  };

  const largestMedia = [...document.querySelectorAll("img, video")].reduce(
    (best, el) => {
      const size =
        el.tagName === "IMG"
          ? el.naturalWidth * el.naturalHeight
          : (el.videoWidth || el.clientWidth) * (el.videoHeight || el.clientHeight);
      return size > best.size ? { el, size } : best;
    },
    { el: null, size: 0 },
  ).el;

  const container = largestMedia ? parentsUp(largestMedia, 6) : null;
  const photos = container
    ? [...container.querySelectorAll("img")]
        .filter((img) => img.naturalWidth > 150 && img.naturalHeight > 150)
        .map((img) => img.src)
    : [];
  const images = photos.length
    ? photos
    : largestMedia?.tagName === "VIDEO" && largestMedia.poster
      ? [largestMedia.poster]
      : largestMedia?.tagName === "IMG"
        ? [largestMedia.src]
        : [];

  let title = document.title.replace(/^\(\d+\+?\)\s*/, "");
  let price = "";
  let place = "";
  let timeListed = "";
  let details = [];
  let description = "";

  const info =
    container && [...container.children].find((child) => !child.contains(largestMedia));

  if (info) {
    let textRoot = info;
    for (let depth = 0; textRoot.children.length < 5 && depth < 10; depth++) {
      if (!textRoot.children.length) break;
      textRoot =
        [...textRoot.children].find((child) => !child.getAttribute("data-visualcompletion")) ||
        textRoot.children[0];
    }

    const heading = textRoot.children[0];
    if (heading) {
      title = heading.querySelector("h1")?.innerText?.trim() || title;

      let priceChild = null;
      for (const child of heading.children) {
        const text = child.innerText;
        if (!/^([$£€]|Free)/i.test(text)) continue;
        const matches = text.match(/([$£€][\d,]+(?:\.\d{2})?|Free)/gi);
        if (matches) {
          price = matches.length > 1 ? `${matches[0]} ~~${matches[1]}~~` : matches[0];
          priceChild = child;
        }
        break;
      }

      for (const child of heading.children) {
        if (child === priceChild) continue;
        const text = child.innerText.trim();
        if (!text || text === title || text.length <= 2) continue;
        if (text.includes("Listed")) timeListed = text;
        else place = text;
      }
    }

    const detailsWrapper = textRoot.children[4];
    if (detailsWrapper) {
      let current = detailsWrapper;
      while (current.children.length === 1) current = current.children[0];

      const content = [...current.children].reduce(
        (best, child) => (child.children.length > best.children.length ? child : best),
        current,
      );
      const rows = content.children.length > 1 ? content : current;
      details = [...rows.children]
        .map((row) => row.innerText.replace(/\n/g, ": ").trim())
        .filter(
          (text) =>
            text.length > 1 &&
            text.length < 200 &&
            !/about this vehicle|seller's description|see less/i.test(text),
        );
    }

    let descChild = null;
    let longest = 0;
    for (let i = 1; i < textRoot.children.length; i++) {
      if (i === 4) continue;
      const text = textRoot.children[i].innerText;
      if (text.length <= longest) continue;
      longest = text.length;
      descChild = textRoot.children[i];
    }

    if (descChild) {
      const expanders = [...descChild.querySelectorAll('button, [role="button"]')].filter((el) =>
        /^See more$/i.test((el.innerText || el.getAttribute("aria-label") || "").trim()),
      );
      for (const expander of expanders) {
        expander.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
      if (expanders.length) await wait(150);

      let descNode = descChild;
      while (descNode.children.length) {
        const longestChild = [...descNode.children].reduce((a, b) =>
          a.innerText.length > b.innerText.length ? a : b,
        );
        if (longestChild.innerText.length <= descNode.innerText.length * 0.6) break;
        descNode = longestChild;
      }
      description = descNode.innerText.replace(/\s*(See more|See less)\s*$/i, "").trim();
    }
  }

  const id = window.location.href.match(/marketplace\/item\/(\d+)/)?.[1];
  if (!id) {
    alert("Could not find a Marketplace item id in this URL.");
    return;
  }

  const listed = (() => {
    const time = timeListed.trim();
    const where = place.trim();
    if (/^Listed\s+.+\s+in\s+.+$/i.test(time)) return time;
    if (time && where) return `Listed ${time.replace(/^Listed\s+/i, "").trim()} in ${where}`;
    if (time) return /^Listed\s+/i.test(time) ? time : `Listed ${time}`;
    if (where) return `Listed on Facebook Marketplace in ${where}`;
    return "Listed on Facebook Marketplace";
  })();

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
        title: title.replace(/^\(\d+\+?\)\s*/, "").trim(),
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
