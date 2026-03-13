chrome.action.onClicked.addListener((tab) => {
    // Only run if we are actually looking at a Marketplace item
    if (tab.url.includes("facebook.com/marketplace/item")) {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: scrapeAndSendToDiscord
        });
    }
});

// This function gets injected into the Facebook page itself
async function scrapeAndSendToDiscord() {
    let debugInfo = [];
    let images = [];
    let title = document.title;
    let description = "No description available.";
    let price = "Check Link";
    let location = "";
    let timeListed = "";
    let condition = "";
    let details = [];

    // --- STRATEGY: Relational & Heuristic ---
    // 1. Find the "Anchor" Media (Largest Image or Video on Page)
    const allMedia = Array.from(document.querySelectorAll('img, video'));
    const largestMedia = allMedia.reduce((max, el) => {
        let size = 0;
        if (el.tagName === 'IMG') {
            size = el.naturalWidth * el.naturalHeight;
        } else {
            size = (el.videoWidth || el.clientWidth) * (el.videoHeight || el.clientHeight);
        }
        return size > max.size ? { element: el, size: size } : max;
    }, { element: null, size: 0 }).element;

    let targetContainer = null;

    if (largestMedia) {
        debugInfo.push(`Found Anchor Media (${largestMedia.tagName})`);
        console.log("Anchor Media:", largestMedia);
        // 2. Hardcoded Traversal: Step out exactly 6 times
        // Path: <media> -> <div> -> <span> -> <div> -> <div> -> <div> -> <div> (Target)
        // We step out exactly 6 times to reach the main container holding both images and text.
        targetContainer = largestMedia.parentElement?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement;

        if (targetContainer) {
            debugInfo.push("Found Target Container (6 Levels Up)");

            // Grab all images in this container
            const siblings = Array.from(targetContainer.querySelectorAll('img'))
                .filter(img => img.naturalWidth > 150 && img.naturalHeight > 150); // Ignore tiny icons

            if (siblings.length > 0) {
                images = siblings.map(img => img.src);
            } else if (largestMedia.tagName === 'VIDEO' && largestMedia.poster) {
                images = [largestMedia.poster];
            } else if (largestMedia.tagName === 'IMG') {
                images = [largestMedia.src];
            }
        }
    }

    // 3. Specific Traversal for Text
    if (targetContainer) {
        try {
            console.log("Starting Specific Traversal from:", targetContainer);
            // (main) -> (the one not containing images)
            // We assume targetContainer has 2 children. Find the one without the anchor image.
            let infoDiv = Array.from(targetContainer.children).find(c => !c.contains(largestMedia));

            if (infoDiv) {
                console.log("Found infoDiv:", infoDiv);

                // Drill down to find the main container (divTEXT)
                // User indicates divTEXT is ~3 steps down and has ~8 children.
                // We loop until we find a div with >= 5 children.
                let current = infoDiv;
                let depth = 0;
                while (current && current.children.length < 5 && depth < 10) {
                    if (current.children.length === 0) break;

                    // Heuristic: Prefer child without 'data-visualcompletion'
                    let next = Array.from(current.children).find(c => !c.getAttribute('data-visualcompletion'));

                    current = next || current.children[0];
                    depth++;
                    console.log(`Drill down depth ${depth}, children: ${current?.children?.length}`);
                }

                let divTEXT = current;

                if (divTEXT) {
                    debugInfo.push("Found divTEXT");
                    console.log("Found divTEXT:", divTEXT);

                    // --- divHEADING ---
                    // divTEXT -> div (first) -> divHEADING
                    let divHEADING = divTEXT.children[0];
                    if (divHEADING) {
                        console.log("Found divHEADING:", divHEADING);

                        // Title: Usually H1
                        let h1 = divHEADING.querySelector('h1');
                        if (h1) title = h1.innerText;

                        // Price: Look for text starting with currency symbol in the direct children
                        // This fixes "Price grabbing Name" by verifying the content format
                        let priceChildIndex = -1;
                        for (let i = 0; i < divHEADING.children.length; i++) {
                            let child = divHEADING.children[i];
                            let text = child.innerText;
                            if (/^([$£€]|Free)/i.test(text)) {
                                const matches = text.match(/([$£€][\d,]+(?:\.\d{2})?|Free)/gi);
                                if (matches) {
                                    price = matches.length > 1 ? `${matches[0]} ~~${matches[1]}~~` : matches[0];
                                    priceChildIndex = i;
                                }
                                break;
                            }
                        }

                        // Location/Time:
                        // Usually the child that contains "Listed" or is just City, State
                        // It is NOT the Title and NOT the Price.
                        for (let i = 0; i < divHEADING.children.length; i++) {
                            if (i === priceChildIndex) continue;
                            let child = divHEADING.children[i];
                            let text = child.innerText;
                            if (text !== title && text.length > 2) {
                                if (text.includes("Listed")) timeListed = text;
                                else location = text;
                            }
                        }
                    } else {
                        debugInfo.push("divHEADING missing");
                    }

                    // --- Details Section ---
                    // User specified path: divTEXT -> nth-child(5) -> div -> children
                    if (divTEXT.children.length > 4) {
                        let detailsWrapper = divTEXT.children[4];
                        if (detailsWrapper) {
                            // Drill down through single-child wrappers to find the split (Header vs Content)
                            let current = detailsWrapper;
                            while (current.children.length === 1) {
                                current = current.children[0];
                            }

                            // We likely have [Header, Content] or [Row1, Row2...].
                            // Find the child with the most sub-elements (rows).
                            let bestContainer = current;
                            let maxKids = 0;
                            for (let i = 0; i < current.children.length; i++) {
                                if (current.children[i].children.length > maxKids) {
                                    maxKids = current.children[i].children.length;
                                    bestContainer = current.children[i];
                                }
                            }

                            // If the best child has > 1 children, use it (it's the content). Else use current.
                            let targetContainer = (maxKids > 1) ? bestContainer : current;

                            for (let i = 0; i < targetContainer.children.length; i++) {
                                let row = targetContainer.children[i];
                                // Extract text, replacing newlines with ": " for key-value pairs
                                let text = row.innerText.replace(/\n/g, ': ').trim();

                                // Filter out headers and noise
                                if (text.match(/about this vehicle|seller's description|see less/i)) continue;

                                if (text.length > 1 && text.length < 200) {
                                    details.push(text);
                                }
                            }
                            if (details.length > 0) debugInfo.push(`Found ${details.length} Details`);
                        }
                    }

                    // --- divDESC ---
                    // Debugging: Log all children to see which one is the description
                    console.log(`divTEXT has ${divTEXT.children.length} children.`);
                    let bestDescChild = null;
                    let maxLen = 0;

                    // Skip index 0 (Heading), scan the rest for the longest text block
                    for (let i = 1; i < divTEXT.children.length; i++) {
                        // Skip the Details section (Index 4) to avoid duplicating it as Description
                        if (i === 4) continue;

                        let child = divTEXT.children[i];
                        let text = child.innerText;
                        console.log(`Child ${i}:`, text.substring(0, 50) + "...");

                        if (text.length > maxLen) {
                            maxLen = text.length;
                            bestDescChild = child;
                        }
                    }

                    if (bestDescChild) {
                        debugInfo.push("Found Description Container");

                        // Drill down to isolate the description from "See less" / Maps
                        // The container often includes the toggle button and location info.
                        // We descend into the child that holds the majority of the text.
                        let descNode = bestDescChild;
                        while (descNode.children.length > 0) {
                            const children = Array.from(descNode.children);
                            const longestChild = children.reduce((a, b) => a.innerText.length > b.innerText.length ? a : b);

                            // If the longest child holds most of the text (e.g. > 60%), go down.
                            // This avoids descending into nodes where text is split (like <br> tags)
                            // but successfully descends past wrappers that contain small buttons like "See less".
                            if (longestChild.innerText.length > descNode.innerText.length * 0.6) {
                                descNode = longestChild;
                            } else {
                                break;
                            }
                        }
                        // Clean up "See less" artifact
                        description = descNode.innerText.replace(/\s*See less[\s\S]*/i, '').trim();
                    }
                } else {
                    debugInfo.push("divTEXT not found (Step 5)");
                }
            } else {
                debugInfo.push("infoDiv not found");
            }
        } catch (e) {
            console.error("Traversal Error:", e);
            debugInfo.push("Traversal Error: " + e.message);
        }
    }

    // Clean up title
    title = title.replace(/^\(\d+\+?\)\s*/, '');
    // Deduplicate images and limit
    images = [...new Set(images)].slice(0, 9);
    const itemUrl = window.location.href;

    // Extract the Marketplace item ID from the URL
    const idMatch = itemUrl.match(/marketplace\/item\/(\d+)/);
    const id = idMatch?.[1];

    if (!id) {
        alert("❌ Could not extract Marketplace item ID from URL.");
        return;
    }

    // Build payload expected by Fixbook backend
    const payload = {
        id,
        title,
        price,
        listed: timeListed || "Listed on Facebook Marketplace",
        details,
        description,
        images,
    };

    // Fallback clipboard approach using a temporary <textarea> so we don't depend
    // on navigator.clipboard (which can fail on some pages/contexts).
    const copyToClipboard = (text) => {
        const el = document.createElement('textarea');
        el.value = text;
        el.setAttribute('readonly', '');
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.focus();
        el.select();
        let success = false;
        try {
            success = document.execCommand('copy');
        } catch (e) {
            console.error('execCommand copy failed', e);
        }
        document.body.removeChild(el);
        return success;
    };

    // Ask the extension background to talk to Fixbook (avoids page CORS).
    chrome.runtime.sendMessage(
        {
            type: "fixbook:createListing",
            payload,
        },
        (response) => {
            if (chrome.runtime.lastError) {
                console.error("Fixbook message error", chrome.runtime.lastError);
                alert(`❌ Fixbook extension error: ${chrome.runtime.lastError.message}`);
                return;
            }

            if (!response || !response.ok) {
                const msg = response?.error || "Unknown error from Fixbook extension.";
                alert(`❌ Fixbook error: ${msg}`);
                return;
            }

            const fixbookUrl = response.url;
            const success = copyToClipboard(fixbookUrl);
            if (success) {
                alert(`✅ Fixbook link copied to clipboard:\n${fixbookUrl}`);
            } else {
                alert(
                    `✅ Fixbook link generated, but could not copy automatically.\n\n` +
                    `URL: ${fixbookUrl}\n\n` +
                    `❌ Clipboard error: document.execCommand('copy') failed`
                );
            }
        }
    );
}

// Background-side handler: receives scrape payload and calls Fixbook API.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "fixbook:createListing") return;

    (async () => {
        try {
            const response = await fetch("https://fixbook-nu.vercel.app/api", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(message.payload),
            });

            if (!response.ok) {
                const text = await response.text();
                sendResponse({
                    ok: false,
                    error: `Fixbook API error (${response.status}): ${text}`,
                });
                return;
            }

            const json = await response.json();
            const listingId = json.id || message.payload?.id;
            const fixbookUrl = `https://fixbook-nu.vercel.app/api/marketplace/item/${encodeURIComponent(
                listingId
            )}`;

            sendResponse({ ok: true, url: fixbookUrl });
        } catch (error) {
            console.error("Fixbook API request failed", error);
            sendResponse({
                ok: false,
                error:
                    error instanceof Error
                        ? error.message
                        : String(error),
            });
        }
    })();

    // Keep the message channel open for async sendResponse
    return true;
});
