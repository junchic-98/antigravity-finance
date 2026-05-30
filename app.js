// ==========================================================================
// SERVERLESS PWA CLIENT LOGIC - ANTIGRAVITY FINANCE
// Runs 100% offline on S23, requires NO computer, stores data in LocalStorage.
// ==========================================================================

let assetsData = {
    summary: { usd_krw_rate: 1350.0 },
    stocks: [],
    transactions: []
};

let activeCurrency = "KRW"; // "KRW" or "USD"
let transactionFilter = "all";

// Empty default - no real financial data stored in code (privacy)
const defaultMockData = {
    "summary": { "usd_krw_rate": 1350.0, "gbp_krw_rate": 1720.0, "app_theme": "light" },
    "stocks": [],
    "transactions": []
};

// Helper to merge duplicate stocks by summing quantities and calculating weighted average purchase price
function mergeDuplicateStocks(stocks) {
    const merged = [];
    stocks.forEach(newStock => {
        const matched = merged.find(s => 
            (s.ticker && newStock.ticker && s.ticker.trim().toLowerCase() === newStock.ticker.trim().toLowerCase()) || 
            (s.name.trim().toLowerCase() === newStock.name.trim().toLowerCase())
        );
        if (matched) {
            const totalQty = matched.quantity + newStock.quantity;
            if (totalQty > 0) {
                matched.avg_purchase_price = 
                    ((matched.quantity * matched.avg_purchase_price) + 
                     (newStock.quantity * newStock.avg_purchase_price)) / totalQty;
            }
            matched.quantity = totalQty;
            matched.current_price = Math.max(matched.current_price, newStock.current_price);
            if (newStock.previous_close) matched.previous_close = newStock.previous_close;
            
            if (matched.brokerage !== newStock.brokerage && newStock.brokerage) {
                if (matched.brokerage === "주식계좌" || matched.brokerage === "종합계좌") {
                    matched.brokerage = newStock.brokerage;
                } else if (!matched.brokerage.includes(newStock.brokerage)) {
                    matched.brokerage = `${matched.brokerage}/${newStock.brokerage}`;
                }
            }
        } else {
            merged.push(newStock);
        }
    });
    return merged;
}

// 1. Data load from phone LocalStorage
function loadLocalStorageData() {
    const data = localStorage.getItem("antigravity_assets_data");
    if (data && data !== "null" && data !== "undefined") {
        try {
            assetsData = JSON.parse(data);
            
            // Defensive checks to guarantee all key arrays and summaries are initialized
            if (!assetsData || typeof assetsData !== 'object') {
                assetsData = JSON.parse(JSON.stringify(defaultMockData));
            }
            if (!assetsData.summary) {
                assetsData.summary = { usd_krw_rate: 1350.0, gbp_krw_rate: 1720.0, app_theme: 'obsidian' };
            }
            if (!assetsData.summary.usd_krw_rate) assetsData.summary.usd_krw_rate = 1350.0;
            if (!assetsData.summary.gbp_krw_rate) assetsData.summary.gbp_krw_rate = 1720.0;
            if (!assetsData.summary.app_theme) assetsData.summary.app_theme = 'light';
            if (!assetsData.stocks) assetsData.stocks = [];
            if (!assetsData.transactions) assetsData.transactions = [];
            
            // If localStorage is empty or corrupted, start with empty portfolio
            if (assetsData.stocks.length === 0) {
                assetsData = JSON.parse(JSON.stringify(defaultMockData));
                saveLocalStorageData();
            } else {
                // Wipe corrupted stocks (quantity 0 or NaN)
                assetsData.stocks = assetsData.stocks.filter(s => s.quantity > 0 && !isNaN(s.current_price));
            }
        } catch(e) {
            console.error("Localstorage parse error, loading defaults", e);
            assetsData = JSON.parse(JSON.stringify(defaultMockData));
            saveLocalStorageData();
        }
    } else {
        assetsData = JSON.parse(JSON.stringify(defaultMockData));
        saveLocalStorageData();
    }
}


// Mathematically synchronize all stock holdings with their transaction history
function syncHoldingsWithTransactions() {
    if (!assetsData.transactions || assetsData.transactions.length === 0) return;
    
    // 1. Group transactions by (asset_name, brokerage_or_bank)
    const txGroups = {};
    assetsData.transactions.forEach(tx => {
        if (tx.category !== "stock") return;
        const key = `${tx.asset_name.trim().toLowerCase()}|||${tx.brokerage_or_bank.trim()}`;
        if (!txGroups[key]) {
            txGroups[key] = [];
        }
        txGroups[key].push(tx);
    });

    // 2. For each group, calculate total quantity and weighted average price chronologically
    const computedStocks = {};
    Object.entries(txGroups).forEach(([key, txs]) => {
        const sortedTxs = [...txs].sort((a, b) => new Date(a.date) - new Date(b.date));
        
        let qty = 0;
        let totalCost = 0;
        let currency = "KRW";
        let ticker = "KR_STK";
        
        sortedTxs.forEach(tx => {
            currency = tx.currency || "KRW";
            if (tx.ticker && tx.ticker !== "KR_STK") {
                ticker = tx.ticker;
            } else if (tx.asset_name.match(/[a-zA-Z]/)) {
                ticker = tx.asset_name.toUpperCase();
            }
            
            if (tx.type === "buy") {
                const txQty = parseFloat(tx.quantity) || 0;
                const txPrice = parseFloat(tx.price) || 0;
                
                if (txQty > 0) {
                    totalCost = ((qty * totalCost) + (txQty * txPrice)) / (qty + txQty || 1);
                    qty += txQty;
                }
            } else if (tx.type === "sell") {
                const txQty = parseFloat(tx.quantity) || 0;
                qty = Math.max(0, qty - txQty);
            }
        });
        
        computedStocks[key] = {
            name: txs[0].asset_name,
            brokerage: txs[0].brokerage_or_bank,
            quantity: qty,
            avg_purchase_price: totalCost,
            currency: currency,
            ticker: ticker
        };
    });

    // 3. Update assetsData.stocks
    Object.entries(computedStocks).forEach(([key, comp]) => {
        const [name, brokerage] = key.split("|||");
        const existingIdx = assetsData.stocks.findIndex(s => 
            s.name.trim().toLowerCase() === name && 
            s.brokerage.trim().toLowerCase() === brokerage.toLowerCase()
        );
        
        if (existingIdx !== -1) {
            const existing = assetsData.stocks[existingIdx];
            if (comp.quantity > 0) {
                existing.quantity = comp.quantity;
                existing.avg_purchase_price = comp.avg_purchase_price;
                existing.currency = comp.currency;
                if (comp.ticker && comp.ticker !== "KR_STK") {
                    existing.ticker = comp.ticker;
                }
            } else {
                // Remove stock if quantity is 0
                assetsData.stocks.splice(existingIdx, 1);
            }
        } else if (comp.quantity > 0) {
            // Add new stock row
            assetsData.stocks.push({
                id: `stock_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                brokerage: comp.brokerage,
                name: comp.name,
                ticker: comp.ticker,
                quantity: comp.quantity,
                avg_purchase_price: comp.avg_purchase_price,
                current_price: comp.avg_purchase_price, 
                currency: comp.currency
            });
        }
    });
}

// 2. Data save to phone LocalStorage
function saveLocalStorageData() {
    syncHoldingsWithTransactions();
    localStorage.setItem("antigravity_assets_data", JSON.stringify(assetsData));
    updateUI();
}

// Format numbers nicely
function formatCurrency(amount, currency) {
    const rate = assetsData.summary.usd_krw_rate || 1350.0;
    
    if (activeCurrency === "KRW") {
        if (currency === "USD") {
            const converted = amount * rate;
            return `₩${Math.round(converted).toLocaleString('ko-KR')}`;
        } else {
            return `₩${Math.round(amount).toLocaleString('ko-KR')}`;
        }
    } else {
        if (currency === "KRW") {
            const converted = amount / rate;
            return `$${converted.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        } else {
            return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
    }
}

// Format numbers nicely with dual currency for foreign stocks
function formatCurrencyDual(amount, currency) {
    const mainStr = formatCurrency(amount, currency);
    if (currency === "USD" && activeCurrency === "KRW") {
        const usdStr = `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        return `${mainStr} <span style="font-size: 0.75em; color: #6b7280; font-weight: 500; margin-left: 4px;">(${usdStr})</span>`;
    }
    return mainStr;
}

// Shared helper: total portfolio value in KRW (avoids duplicate calculations)
function calcTotalKRW() {
    const rate = assetsData.summary.usd_krw_rate || 1350.0;
    return assetsData.stocks.reduce((total, item) => {
        const val = item.quantity * item.current_price;
        return total + (item.currency === "KRW" ? val : val * rate);
    }, 0);
}

// Calculate totals and render views
function updateUI() {
    const rate = assetsData.summary.usd_krw_rate || 1350.0;
    
    // Update live rates dashboard board
    const usdRateVal = assetsData.summary.usd_krw_rate || 1350.0;
    const gbpRateVal = assetsData.summary.gbp_krw_rate || 1720.0;
    const rateUsdEl = document.getElementById("rate-usd-krw");
    const rateGbpEl = document.getElementById("rate-gbp-krw");
    if (rateUsdEl) rateUsdEl.textContent = `₩${Number(usdRateVal).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (rateGbpEl) rateGbpEl.textContent = `₩${Number(gbpRateVal).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // Calculate total assets (using shared helper)
    const totalStocksKRW = calcTotalKRW();
    const netWorthKRW = totalStocksKRW;
    
    // 1. Render Net Worth Display
    const nwDisplay = document.getElementById("net-worth-display");
    if (activeCurrency === "KRW") {
        nwDisplay.textContent = `₩${Math.round(netWorthKRW).toLocaleString('ko-KR')}`;
    } else {
        const netWorthUSD = netWorthKRW / rate;
        nwDisplay.textContent = `$${netWorthUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    // 2. Render SVG Charts
    renderSVGDonutChart(totalStocksKRW);

    // 4. Render Stock Holdings
    const stocksContainer = document.getElementById("stocks-list");
    stocksContainer.innerHTML = "";
    const displayStocks = mergeDuplicateStocks(assetsData.stocks);
    if (displayStocks.length === 0) {
        stocksContainer.innerHTML = `<div class="asset-card" style="justify-content: center; color: var(--text-dim); font-size: 13px;">등록된 주식 자산이 없습니다.</div>`;
    } else {
        displayStocks.forEach(item => {
            try {
            const val = item.quantity * item.current_price;
            const card = document.createElement("div");
            card.className = "asset-card stock-card";
            
            // 1. Calculate profits
            const purchaseTotal = item.quantity * item.avg_purchase_price;
            const currentTotal = item.quantity * item.current_price;
            const profitVal = currentTotal - purchaseTotal;
            const profitPct = purchaseTotal > 0 ? (profitVal / purchaseTotal) * 100 : 0;
            const isProfit = profitVal >= 0;
            
            const profitText = `${isProfit ? '+' : ''}${profitPct.toFixed(2)}%`;
            const profitClass = isProfit ? "text-success" : "text-danger";

            // 2. Brokerage badge parsing - Disabled (No mini badges required)
            let brokerageBadgeHtml = "";

            // 3. Calculate daily change based on previous close
            let dailyText = "0.00%";
            let dailyBadgeClass = "flat";
            if (item.previous_close) {
                const dailyDiff = item.current_price - item.previous_close;
                const dailyPct = (dailyDiff / item.previous_close) * 100;
                const isUp = dailyDiff > 0;
                const isDown = dailyDiff < 0;
                
                if (isUp) {
                    dailyText = `▲${dailyPct.toFixed(2)}%`;
                    dailyBadgeClass = "up";
                } else if (isDown) {
                    dailyText = `▼${Math.abs(dailyPct).toFixed(2)}%`;
                    dailyBadgeClass = "down";
                } else {
                    dailyText = "0.00%";
                    dailyBadgeClass = "flat";
                }
            }

            // 4. Check for USD/foreign stocks and format pricing
            const isUSStock = !/^\d+$/.test(item.ticker) && !item.ticker.endsWith(".KS") && !item.ticker.endsWith(".KQ");
            
            let avgPriceText = "";
            let currentPriceText = "";
            let prevCloseText = "";
            
            if (item.currency === "USD") {
                // If stored in USD, the database values are already in USD!
                const usdAvg = item.avg_purchase_price;
                const usdCurrent = item.current_price;
                const usdPrev = item.previous_close || 0;
                
                const krwAvg = usdAvg * rate;
                const krwCurrent = usdCurrent * rate;
                const krwPrev = usdPrev * rate;
                
                avgPriceText = `<span style="color: var(--text-main);">₩${Math.round(krwAvg).toLocaleString()}</span> <span class="stock-detail-val usd">$${usdAvg.toFixed(2)}</span>`;
                currentPriceText = `<span style="color: var(--text-main);">₩${Math.round(krwCurrent).toLocaleString()}</span> <span class="stock-detail-val usd">$${usdCurrent.toFixed(2)}</span>`;
                prevCloseText = usdPrev ? `<span style="color: var(--text-main);">₩${Math.round(krwPrev).toLocaleString()}</span> <span class="stock-detail-val usd">$${usdPrev.toFixed(2)}</span>` : "-";
            } else {
                // If stored in KRW
                const krwAvg = item.avg_purchase_price;
                const krwCurrent = item.current_price;
                const krwPrev = item.previous_close || 0;
                
                if (isUSStock) {
                    const usdAvg = krwAvg / rate;
                    const usdCurrent = krwCurrent / rate;
                    const usdPrev = krwPrev / rate;
                    
                    avgPriceText = `<span style="color: var(--text-main);">₩${Math.round(krwAvg).toLocaleString()}</span> <span class="stock-detail-val usd">$${usdAvg.toFixed(2)}</span>`;
                    currentPriceText = `<span style="color: var(--text-main);">₩${Math.round(krwCurrent).toLocaleString()}</span> <span class="stock-detail-val usd">$${usdCurrent.toFixed(2)}</span>`;
                    prevCloseText = krwPrev ? `<span style="color: var(--text-main);">₩${Math.round(krwPrev).toLocaleString()}</span> <span class="stock-detail-val usd">$${usdPrev.toFixed(2)}</span>` : "-";
                } else {
                    avgPriceText = `₩${Math.round(krwAvg).toLocaleString()}`;
                    currentPriceText = `₩${Math.round(krwCurrent).toLocaleString()}`;
                    prevCloseText = krwPrev ? `₩${Math.round(krwPrev).toLocaleString()}` : "-";
                }
            }

            // 5. Structure Card InnerHTML
            card.innerHTML = `
                <div class="stock-card-header">
                    <div class="asset-meta">
                        <div style="display: flex; align-items: center; gap: 4px;">
                            <span class="asset-title">${getInstitutionIcon(item.brokerage)} ${item.name}</span>
                            ${brokerageBadgeHtml}
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span class="price-change-badge ${dailyBadgeClass}">${dailyText}</span>
                        <span class="badge ${profitClass}" style="font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 6px; background: ${isProfit ? 'var(--color-success-glow)' : 'var(--color-danger-glow)'}">${profitText}</span>
                    </div>
                </div>
                
                <div class="stock-details-grid">
                    <div class="stock-detail-item">
                        <span class="stock-detail-label">보유수량</span>
                        <span class="stock-detail-val" style="color: var(--text-main); font-weight: 700;">${item.quantity}주</span>
                    </div>
                    <div class="stock-detail-item">
                        <span class="stock-detail-label">평매수단가</span>
                        <span class="stock-detail-val">${avgPriceText}</span>
                    </div>
                    <div class="stock-detail-item">
                        <span class="stock-detail-label">현재가격</span>
                        <span class="stock-detail-val" style="font-weight: 700;">${currentPriceText}</span>
                    </div>
                    <div class="stock-detail-item">
                        <span class="stock-detail-label">어제종가</span>
                        <span class="stock-detail-val">${prevCloseText}</span>
                    </div>
                </div>
            `;
            
            // Single click to open detail bottom sheet drawer
            card.addEventListener("click", () => {
                openStockDrawer(item);
            });
            
            card.addEventListener("dblclick", (e) => {
                e.stopPropagation();
                if (confirm(`[${item.brokerage || '기본계좌'}] ${item.name} 주식을 완전히 제거하시겠습니까? (연동된 모든 계좌의 보유분이 일괄 삭제됩니다)`)) {
                    assetsData.stocks = assetsData.stocks.filter(s => 
                        !(s.name.toLowerCase() === item.name.toLowerCase() || 
                          (s.ticker && item.ticker && s.ticker.toLowerCase() === item.ticker.toLowerCase()))
                    );
                    saveLocalStorageData();
                    showToast("삭제 완료", "주식 항목이 포트폴리오에서 일괄 삭제되었습니다.");
                }
            });
            stocksContainer.appendChild(card);
            } catch(cardErr) {
                console.error(`Stock card render error for ${item.name || item.id}:`, cardErr);
                // Render a fallback minimal card so the error doesn't kill the whole list
                const errCard = document.createElement("div");
                errCard.className = "asset-card stock-card";
                errCard.innerHTML = `<div class="asset-meta"><span class="asset-title">${item.name || '알수없음'} <span style="color:var(--color-danger);font-size:10px">[표시 오류]</span></span></div>`;
                stocksContainer.appendChild(errCard);
            }
        });
    }

    renderTransactions();
    renderAnalysisViews();
}

// Map institution names to premium icons
function getInstitutionIcon(name) {
    if (!name || typeof name !== 'string') return `<i class="fa-solid fa-building-columns" style="color: var(--text-dim);"></i>`;
    if (/\d/.test(name)) return `<i class="fa-solid fa-wallet" style="color: #10b981;"></i>`;
    if (name.includes("토스")) return `<i class="fa-solid fa-bolt" style="color: #3b82f6;"></i>`;
    if (name.includes("신한")) return `<i class="fa-solid fa-s" style="color: #1d4ed8;"></i>`;
    if (name.includes("국민") || name.includes("KB")) return `<i class="fa-solid fa-k" style="color: #f59e0b;"></i>`;
    if (name.includes("한국투자") || name.includes("한투")) return `<i class="fa-solid fa-h" style="color: #06b6d4;"></i>`;
    if (name.includes("NH") || name.includes("나무")) return `<i class="fa-solid fa-n" style="color: #00b300;"></i>`;
    if (name.includes("우리")) return `<i class="fa-solid fa-w" style="color: #3b82f6;"></i>`;
    if (name.includes("하나")) return `<i class="fa-solid fa-g" style="color: #10b981;"></i>`;
    if (name.includes("카카오")) return `<i class="fa-solid fa-comment" style="color: #facc15;"></i>`;
    if (name.includes("키움")) return `<i class="fa-solid fa-key" style="color: #ec4899;"></i>`;
    return `<i class="fa-solid fa-building-columns" style="color: var(--text-dim);"></i>`;
}

// Render SVG Doughnut Chart mathematically with clean arcs and animations
function renderSVGDonutChart(stocksTotal) {
    const rate = assetsData.summary.usd_krw_rate || 1350.0; // Get rate within this function scope!
    const total = stocksTotal;
    const segmentsContainer = document.getElementById("donut-segments");
    const legendContainer = document.getElementById("chart-legend-container");
    const centerPercentText = document.getElementById("chart-center-percentage");

    segmentsContainer.innerHTML = "";
    legendContainer.innerHTML = "";

    if (total === 0) {
        centerPercentText.textContent = "0%";
        return;
    }

    const colors = [
        "#3b82f6", // Electric Blue
        "#06b6d4", // Cyan Neon
        "#8b5cf6", // Purple Aura
        "#10b981", // Emerald Growth
        "#facc15", // Golden Yellow
        "#ec4899", // Deep Pink
        "#f97316", // Neon Orange
        "#14b8a6", // Teal
        "#a78bfa", // Lavender
        "#f43f5e", // Rose Red
        "#38bdf8", // Sky Cyan
        "#c084fc"  // Light Violet
    ];

    const segments = [];
    
    // Add Stocks segments dynamically
    const displayStocks = mergeDuplicateStocks(assetsData.stocks);
    displayStocks.forEach((item, idx) => {
        const val = item.quantity * item.current_price * (item.currency === "USD" ? rate : 1);
        const colorIdx = idx % colors.length;
        segments.push({
            name: item.name,
            value: val,
            color: colors[colorIdx],
            class: `stock-${idx}`
        });
    });

    // Sort segments by value descending to make the chart look extremely professional!
    segments.sort((a, b) => b.value - a.value);

    let currentOffset = 0;
    const radius = 80;
    const circumference = 2 * Math.PI * radius; // 502.65

    segments.forEach((seg, index) => {
        const percentage = seg.value / total;
        const strokeLength = percentage * circumference;
        const targetOffset = -currentOffset;

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", "110");
        circle.setAttribute("cy", "110");
        circle.setAttribute("r", radius.toString());
        circle.className.baseVal = `donut-segment ${seg.class}`;
        circle.setAttribute("stroke", seg.color);
        
        circle.setAttribute("stroke-dasharray", `${strokeLength} ${circumference}`);
        circle.setAttribute("stroke-dashoffset", circumference.toString());
        
        setTimeout(() => {
            circle.setAttribute("stroke-dashoffset", targetOffset.toString());
        }, 50);

        segmentsContainer.appendChild(circle);
        
        currentOffset += strokeLength;

        // Render compact inline horizontal legend tag!
        if (seg.value > 0) {
            const legendItem = document.createElement("div");
            legendItem.className = "legend-item";
            legendItem.innerHTML = `
                <span class="legend-color" style="background: ${seg.color}"></span>
                <span class="legend-name">${seg.name}</span>
                <span class="legend-val">${Math.round(percentage * 100)}%</span>
            `;
            legendContainer.appendChild(legendItem);
        }
    });

    centerPercentText.textContent = `${assetsData.stocks.length}종목`;
    document.querySelector(".chart-center-label").textContent = "보유 주식";
}

// Render Transactions history
function renderTransactions() {
    const listContainer = document.getElementById("transactions-list");
    if (!listContainer) return;
    listContainer.innerHTML = "";

    // 1. Apply search & date query filters
    const searchQuery = document.getElementById("input-tx-search") ? document.getElementById("input-tx-search").value.trim().toLowerCase() : "";
    const startDateVal = document.getElementById("input-tx-start") ? document.getElementById("input-tx-start").value : "";
    const endDateVal = document.getElementById("input-tx-end") ? document.getElementById("input-tx-end").value : "";
    
    const startDateTime = startDateVal ? new Date(startDateVal + "T00:00:00").getTime() : null;
    const endDateTime = endDateVal ? new Date(endDateVal + "T23:59:59").getTime() : null;

    const filtered = assetsData.transactions.filter(tx => {
        // Tab type filter
        if (transactionFilter !== "all" && tx.type !== transactionFilter) return false;
        
        // Search text query filter (name or brokerage/bank)
        if (searchQuery) {
            const matchesName = tx.asset_name && tx.asset_name.toLowerCase().includes(searchQuery);
            const matchesBrokerage = tx.brokerage_or_bank && tx.brokerage_or_bank.toLowerCase().includes(searchQuery);
            if (!matchesName && !matchesBrokerage) return false;
        }
        
        // Date range filter
        if (startDateTime || endDateTime) {
            const txTime = new Date(tx.date).getTime();
            if (startDateTime && txTime < startDateTime) return false;
            if (endDateTime && txTime > endDateTime) return false;
        }
        
        return true;
    });

    if (filtered.length === 0) {
        listContainer.innerHTML = `<div class="tx-item" style="justify-content: center; color: var(--text-dim); font-size: 13px;">해당 거래 내역이 없습니다.</div>`;
        return;
    }

    filtered.forEach(tx => {
        const item = document.createElement("div");
        item.className = "tx-item animate-fade-in";
        
        let iconClass = "fa-solid ";
        let badgeType = tx.type;
        if (tx.type === "buy") iconClass += "fa-basket-shopping";
        else if (tx.type === "sell") iconClass += "fa-chart-line-down";
        else if (tx.type === "deposit") iconClass += "fa-arrow-down-to-bracket";
        else if (tx.type === "withdraw") iconClass += "fa-arrow-up-from-bracket";

        const isPlus = tx.type === "buy" || tx.type === "deposit";
        const sign = isPlus ? "+" : "-";
        const amtClass = isPlus ? "plus" : "minus";

        let dateStr = tx.date;
        try {
            const d = new Date(tx.date);
            dateStr = `${String(d.getMonth()+1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        } catch(e) {}

        const detailsSub = tx.category === "stock" ? `${tx.quantity}주 · ${formatCurrency(tx.price, tx.currency)}` : "";

        item.innerHTML = `
            <div class="tx-icon-block ${badgeType}">
                <i class="${iconClass}"></i>
            </div>
            <div class="tx-body">
                <span class="tx-name">[${tx.brokerage_or_bank}] ${tx.asset_name} ${tx.type === "buy" ? '매수' : tx.type === "sell" ? '매도' : tx.type === "deposit" ? '입금' : '출금'}</span>
                <span class="tx-meta">${dateStr}</span>
            </div>
            <div class="tx-value">
                <span class="tx-amount ${amtClass}">${sign}${formatCurrency(tx.amount, tx.currency)}</span>
                <span class="tx-details-sub">${detailsSub}</span>
            </div>
        `;
        
        // Single click to open premium digital statement receipt modal
        item.addEventListener("click", () => {
            openTxReceipt(tx);
        });
        
        item.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            if (confirm("이 거래 내역을 삭제하시겠습니까? (보유량 계산에는 반영되지 않으며 이 로그만 제거됩니다)")) {
                assetsData.transactions = assetsData.transactions.filter(t => t.id !== tx.id);
                saveLocalStorageData();
                showToast("삭제 완료", "거래 내역이 삭제되었습니다.");
            }
        });

        listContainer.appendChild(item);
    });
}

function filterTransactions(type) {
    transactionFilter = type;
    
    const btns = document.querySelectorAll(".filter-btn");
    btns.forEach(btn => {
        if (btn.textContent.includes(type === "all" ? "전체" : type === "buy" ? "매수" : type === "sell" ? "매도" : "입적금")) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });
    
    renderTransactions();
}

// Tab switcher logic
function initTabNavigation() {
    const navItems = document.querySelectorAll(".nav-item");
    const panes = document.querySelectorAll(".tab-pane");

    navItems.forEach(item => {
        item.addEventListener("click", () => {
            const targetTab = item.getAttribute("data-tab");
            
            navItems.forEach(i => i.classList.remove("active"));
            panes.forEach(p => p.classList.remove("active"));

            item.classList.add("active");
            document.getElementById(targetTab).classList.add("active");
            
            document.getElementById("scroll-container").scrollTop = 0;
        });
    });
}

// Show beautiful toast alerts
function showToast(title, message, type = "success") {
    const toast = document.getElementById("toast");
    const toastIcon = toast.querySelector(".toast-icon i");
    const toastTitle = toast.querySelector(".toast-title");
    const toastMsg = toast.querySelector(".toast-message");

    toastTitle.textContent = title;
    toastMsg.textContent = message;

    if (type === "success") {
        toast.style.borderColor = "var(--color-success)";
        toastIcon.className = "fa-solid fa-circle-check";
        toastIcon.style.color = "var(--color-success)";
    } else if (type === "error") {
        toast.style.borderColor = "var(--color-danger)";
        toastIcon.className = "fa-solid fa-circle-xmark";
        toastIcon.style.color = "var(--color-danger)";
    } else {
        toast.style.borderColor = "var(--color-accent)";
        toastIcon.className = "fa-solid fa-circle-info";
        toastIcon.style.color = "var(--color-accent)";
    }

    toast.style.display = "flex";
    
    setTimeout(() => {
        toast.style.display = "none";
    }, 3200);
}

// Modal open/close actions
function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.style.display = "flex";
    }
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.style.display = "none";
    }
}

// Open manual asset input form
function openAddAssetModal(type) {
    document.getElementById("asset-type-hidden").value = type;
    const stockFields = document.getElementById("stock-only-fields");
    const instLabel = document.getElementById("label-institution");
    const instInput = document.getElementById("input-institution");
    const modalTitle = document.getElementById("asset-modal-title");
    
    // Reset inputs
    instInput.value = "";
    document.getElementById("input-stock-name").value = "";
    document.getElementById("input-stock-ticker").value = "";
    document.getElementById("input-stock-qty").value = "";
    document.getElementById("input-stock-buy-price").value = "";
    document.getElementById("input-balance").value = "";

    modalTitle.textContent = "주식 포트폴리오 수동 등록";
    instLabel.textContent = "계좌번호";
    instInput.placeholder = "예: 203-01-265287";
    if (stockFields) stockFields.style.display = "block";
    document.getElementById("group-balance-input").style.display = "block";
    document.getElementById("label-balance").textContent = "현재 주식 1주 시세";
    
    openModal("modal-add-asset");
}

// Submit manually created asset
async function submitAddAsset() {
    const type = document.getElementById("asset-type-hidden").value;
    const institution = document.getElementById("input-institution").value.trim();
    const accountNumber = document.getElementById("input-account-number") ? document.getElementById("input-account-number").value.trim() : "";
    const currency = document.getElementById("input-currency").value;

    if (!institution) {
        alert("계좌번호를 입력해 주세요.");
        return;
    }

    const stockName = document.getElementById("input-stock-name").value.trim();
    const qty = parseFloat(document.getElementById("input-stock-qty").value) || 0;
    const buyPrice = parseFloat(document.getElementById("input-stock-buy-price").value) || 0;
    const currentPrice = parseFloat(document.getElementById("input-balance").value) || buyPrice;
    let ticker = document.getElementById("input-stock-ticker").value.trim().toUpperCase();

    if (!stockName) {
        alert("주식명을 입력해 주세요.");
        return;
    }

    if (!ticker) {
        ticker = stockName.match(/[a-zA-Z]/) ? stockName.toUpperCase() : "KR_STK";
    }

    const newStock = {
        id: `stock_${Date.now()}`,
        brokerage: institution,
        account_number: accountNumber, // Store account number
        name: stockName,
        ticker: ticker,
        quantity: qty,
        avg_purchase_price: buyPrice,
        current_price: currentPrice,
        currency: currency
    };
    assetsData.stocks.push(newStock);

    closeModal("modal-add-asset");
    saveLocalStorageData();
    showToast("자산 등록 완료", "자산 정보가 실시간 반영되었습니다.");
}

// Open manual transaction form
function populateOwnedStocksDatalist() {
    const datalist = document.getElementById("owned-stocks-datalist");
    if (!datalist) return;
    datalist.innerHTML = "";
    const uniqueNames = [...new Set(assetsData.stocks.map(s => s.name))];
    uniqueNames.forEach(name => {
        const option = document.createElement("option");
        option.value = name;
        datalist.appendChild(option);
    });
}

function openAddTxModal() {
    activeEditTxId = null; // Reset edit state
    
    const modalTitle = document.querySelector("#modal-add-tx .modal-title");
    if (modalTitle) modalTitle.textContent = "거래 내역 직접 등록";
    
    const submitBtn = document.querySelector("#modal-add-tx .btn-primary");
    if (submitBtn) {
        submitBtn.innerHTML = `<i class="fa-solid fa-circle-check"></i> 등록 완료`;
    }

    populateOwnedStocksDatalist();
    document.getElementById("input-tx-brokerage").value = "";
    document.getElementById("input-tx-asset-name").value = "";
    document.getElementById("input-tx-qty").value = "";
    document.getElementById("input-tx-price").value = "";
    document.getElementById("input-tx-amount").value = "";
    
    toggleTxCategoryFields();
    openModal("modal-add-tx");
}

function toggleTxCategoryFields() {
    const category = document.getElementById("input-tx-category").value;
    const typeSelect = document.getElementById("input-tx-type");
    const stockFields = document.getElementById("tx-stock-fields");
    const nameLabel = document.getElementById("label-tx-asset-name");
    
    typeSelect.innerHTML = "";

    if (category === "stock") {
        nameLabel.textContent = "주식 종목명";
        stockFields.style.display = "block";
        typeSelect.innerHTML = `
            <option value="buy">주식 매수 (Buy)</option>
            <option value="sell">주식 매도 (Sell)</option>
        `;
    } else {
        nameLabel.textContent = "계좌명";
        stockFields.style.display = "none";
        typeSelect.innerHTML = `
            <option value="deposit">계좌 입금 (Deposit)</option>
            <option value="withdraw">계좌 출금 (Withdraw)</option>
        `;
    }
}

// Submit manually created Transaction log
async function submitAddTx() {
    const category = document.getElementById("input-tx-category").value;
    const type = document.getElementById("input-tx-type").value;
    const brokerage = document.getElementById("input-tx-brokerage").value.trim() || "기본계좌";
    const assetName = document.getElementById("input-tx-asset-name").value.trim();
    const currency = document.getElementById("input-tx-currency").value;

    if (!assetName) {
        alert("자산 또는 주식명을 입력해 주세요.");
        return;
    }

    let qty = null;
    let price = null;
    let amount = 0;

    if (category === "stock") {
        qty = parseFloat(document.getElementById("input-tx-qty").value) || 0;
        price = parseFloat(document.getElementById("input-tx-price").value) || 0;
        amount = qty * price;
    } else {
        amount = parseFloat(document.getElementById("input-tx-amount").value) || 0;
    }

    if (activeEditTxId) {
        const tx = assetsData.transactions.find(t => t.id === activeEditTxId);
        if (tx) {
            tx.category = category;
            tx.type = type;
            tx.brokerage_or_bank = brokerage;
            tx.asset_name = assetName;
            tx.currency = currency;
            tx.quantity = qty;
            tx.price = price;
            tx.amount = amount;
        }
    } else {
        const newTx = {
            id: `tx_${Date.now()}`,
            date: new Date().toISOString(),
            type: type,
            category: category,
            asset_name: assetName,
            brokerage_or_bank: brokerage,
            quantity: qty,
            price: price,
            amount: amount,
            currency: currency
        };
        assetsData.transactions.unshift(newTx);
    }

    closeModal("modal-add-tx");
    saveLocalStorageData();
    showToast("내역 등록 성공", "거래 로그 기록 및 포트폴리오를 갱신했습니다.");
}



// --------------------------------------------------------------------------
// CLIENT-SIDE HIGH-FIDELITY SCREENSHOT SCANNER (SERVERLESS)
// --------------------------------------------------------------------------
let screenshotResultCache = null;



// Parse Korean brokerage holdings table screenshots with structured row parsing


// Process OCR loading sequences inside the browser (zero server dependencies!)




// --------------------------------------------------------------------------
// DATA BACKUP & RESTORE UTILITIES (PREVENTS CACHE-CLEAR DATA LOSS)
// --------------------------------------------------------------------------
function setupBackupAndRestore() {
    // Inject backup controls into the dashboard tab dynamically
    const dashboardPane = document.getElementById("tab-dashboard");
    const backupContainer = document.createElement("div");
    backupContainer.className = "glass-panel";
    backupContainer.style.marginTop = "20px";
    backupContainer.innerHTML = `
        <div class="panel-header">
            <h3 class="panel-title"><i class="fa-solid fa-database text-accent"></i> 자산 데이터 백업 및 복원</h3>
        </div>
        <div class="form-row" style="gap: 10px; margin-bottom: 10px;">
            <button class="btn-primary col-6" id="btn-export-backup" style="font-size: 12px; padding: 10px;"><i class="fa-solid fa-file-export"></i> JSON 백업 저장</button>
            <button class="btn-secondary col-6" id="btn-import-trigger" style="font-size: 12px; padding: 10px;"><i class="fa-solid fa-file-import"></i> JSON 백업 복원</button>
        </div>
        <div class="form-row" style="gap: 10px;">
            <button class="btn-accent col-6" id="btn-export-csv" style="font-size: 12px; padding: 10px;"><i class="fa-solid fa-file-csv"></i> CSV 파일 추출</button>
            <button class="btn-secondary col-6" id="btn-import-csv-trigger" style="font-size: 12px; padding: 10px;"><i class="fa-solid fa-file-circle-plus"></i> CSV 파일 입력</button>
        </div>
        <input type="file" id="csv-file-input" accept=".csv" style="display: none;">
        <div style="margin-top: 12px; border-top: 1px dashed var(--glass-border); padding-top: 12px; display: flex; justify-content: space-between; align-items: center;">
            <button class="btn-primary" id="btn-deduplicate-data" style="background: rgba(16, 185, 129, 0.1); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.2); font-size: 11px; padding: 6px 12px; border-radius: 8px;"><i class="fa-solid fa-broom"></i> 중복 데이터 정리</button>
            <button class="btn-secondary" id="btn-reset-data" style="background: rgba(239, 68, 68, 0.1); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.2); font-size: 11px; padding: 6px 12px; border-radius: 8px;"><i class="fa-solid fa-trash-can"></i> 전체 데이터 초기화</button>
        </div>
        <input type="file" id="backup-file-input" accept=".json" style="display: none;">
    `;
    
    // Add to the bottom of the parser tab
    const versionEl = dashboardPane.querySelector("div[style*='Antigravity Finance']");
    if (versionEl) {
        dashboardPane.insertBefore(backupContainer, versionEl);
    } else {
        dashboardPane.appendChild(backupContainer);
    }

    // Bind export button
    document.getElementById("btn-export-backup").addEventListener("click", () => {
        const dataStr = JSON.stringify(assetsData, null, 2);
        const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
        
        const exportFileDefaultName = `antigravity_finance_backup_${new Date().toISOString().slice(0, 10)}.json`;
        
        const linkElement = document.createElement('a');
        linkElement.setAttribute('href', dataUri);
        linkElement.setAttribute('download', exportFileDefaultName);
        linkElement.click();
        showToast("백업 완료", "백업 파일 다운로드가 시작되었습니다.");
    });

    // Bind deduplicate button
    const btnDeduplicate = document.getElementById("btn-deduplicate-data");
    if (btnDeduplicate) {
        btnDeduplicate.addEventListener("click", () => {
            const originalCount = assetsData.stocks.length;
            const merged = mergeDuplicateStocks(assetsData.stocks);
            
            // Save merged array back to database
            assetsData.stocks = merged;
            saveLocalStorageData();
            
            const purgedCount = originalCount - merged.length;
            if (purgedCount > 0) {
                showToast("중복 정리 완료", `${purgedCount}개의 중복 찌꺼기 데이터가 성공적으로 병합되었습니다!`, "success");
            } else {
                showToast("정리할 내역 없음", "포트폴리오에 중복된 찌꺼기 데이터가 없습니다.", "info");
            }
        });
    }

    // Bind reset button
    document.getElementById("btn-reset-data").addEventListener("click", () => {
        if (confirm("정말로 모든 보유 자산 및 거래 내역 데이터를 삭제하고 초기화하시겠습니까?\n(이 작업은 되돌릴 수 없으므로 필요 시 먼저 백업을 생성해 두세요!)")) {
            if (confirm("최종 확인: 정말로 초기화하시겠습니까? 모든 로컬 데이터가 삭제됩니다.")) {
                localStorage.removeItem("antigravity_assets_data");
                assetsData = JSON.parse(JSON.stringify(defaultMockData));
                saveLocalStorageData();
                showToast("초기화 완료", "모든 데이터가 완전히 초기화되었습니다.", "success");
            }
        }
    });

    // Bind import trigger
    const fileInput = document.getElementById("backup-file-input");
    document.getElementById("btn-import-trigger").addEventListener("click", () => {
        fileInput.click();
    });

    // Bind CSV Export
    document.getElementById("btn-export-csv").addEventListener("click", () => {
        if (assetsData.stocks.length === 0) {
            showToast("CSV 추출 실패", "추출할 주식 자산이 없습니다.", "error");
            return;
        }
        let csvContent = "﻿계좌번호,종목명,티커,보유수량,평수단가,통화(KRW or USD)\n";
        assetsData.stocks.forEach(s => {
            csvContent += `"${s.brokerage || ''}","${s.name || ''}","${s.ticker || ''}",${s.quantity || 0},${s.avg_purchase_price || 0},"${s.currency || 'KRW'}"\n`;
        });
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `antigravity_portfolio_${new Date().toISOString().slice(0, 10)}.csv`);
        link.click();
        showToast("CSV 추출 성공", "포트폴리오 CSV 파일이 다운로드되었습니다.");
    });

    // Bind CSV Import trigger
    const csvFileInput = document.getElementById("csv-file-input");
    document.getElementById("btn-import-csv-trigger").addEventListener("click", () => {
        csvFileInput.click();
    });

    // Bind CSV File Load
    csvFileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(evt) {
            try {
                const text = evt.target.result;
                const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
                if (lines.length <= 1) {
                    showToast("오류", "CSV 파일에 데이터가 없습니다.", "error");
                    return;
                }

                const importedStocks = [];
                for (let i = 1; i < lines.length; i++) {
                    const row = lines[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v.replace(/^"|"$/g, '').trim());
                    if (row.length < 5) continue;
                    
                    const brokerage = row[0] || "기본계좌";
                    const name = row[1];
                    const ticker = row[2] || (name.match(/[a-zA-Z]/) ? "US_STK" : "KR_STK");
                    const quantity = parseFloat(row[3]) || 0;
                    const avg_purchase_price = parseFloat(row[4]) || 0;
                    const currency = row[5] || "KRW";

                    if (!name || quantity <= 0) continue;

                    importedStocks.push({
                        id: `stock_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                        brokerage: brokerage,
                        name: name,
                        ticker: ticker.toUpperCase(),
                        quantity: quantity,
                        avg_purchase_price: avg_purchase_price,
                        current_price: avg_purchase_price, // default current price to purchase price
                        currency: currency.toUpperCase()
                    });
                }

                if (importedStocks.length > 0) {
                    if (confirm(`CSV 파일에서 ${importedStocks.length}개의 주식 자산을 읽어왔습니다. 기존 자산 목록에 추가하시겠습니까?\n(취소 시 기존 자산을 덮어씁니다.)`)) {
                        assetsData.stocks.push(...importedStocks);
                    } else {
                        assetsData.stocks = importedStocks;
                    }
                    saveLocalStorageData();
                    updateStockPrices(); // dynamically fetch fresh prices for all imported stocks
                    showToast("CSV 가져오기 성공", "주식 자산 포트폴리오를 성공적으로 갱신했습니다!");
                } else {
                    showToast("가져오기 실패", "올바른 CSV 형식의 데이터가 없습니다.", "error");
                }
            } catch(err) {
                showToast("오류", "CSV 파일 파싱 중 에러가 발생했습니다.", "error");
            }
        };
        reader.readAsText(file, "EUC-KR"); // Support Korean encoding Excel CSV files
        csvFileInput.value = ""; // reset file input
    });

    // Bind file input change
    fileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(evt) {
            try {
                const importedData = JSON.parse(evt.target.result);
                if (importedData.stocks && importedData.transactions) {
                    assetsData = importedData;
                    saveLocalStorageData();
                    showToast("복원 성공", "자산 데이터가 백업 파일에서 안전하게 복원되었습니다!");
                } else {
                    showToast("복원 실패", "올바른 백업 파일 구조가 아닙니다.", "error");
                }
            } catch(err) {
                showToast("오류", "파일 형식이 올바르지 않습니다.", "error");
            }
        };
        reader.readAsText(file);
    });
}

// --------------------------------------------------------------------------
// ANDROID STANDALONE APP INSTALL & SERVICE WORKER SETUP
// --------------------------------------------------------------------------
function registerServiceWorkerLocal() {
    // Generate minimal Service Worker inline for seamless PWA execution!
    if ('serviceWorker' in navigator) {
        const swBlob = new Blob([`
            const CACHE_NAME = 'antigravity-finance-v38';
            const ASSETS = [
                './',
                './index.html',
                './style.css',
                './app.js?v=38'
            ];
            self.addEventListener('install', e => {
                self.skipWaiting();
                e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
            });
            self.addEventListener('activate', e => {
                e.waitUntil(
                    caches.keys().then(keys => Promise.all(
                        keys.map(key => {
                            if (key !== CACHE_NAME) {
                                return caches.delete(key);
                            }
                        })
                    )).then(() => self.clients.claim())
                );
            });
            self.addEventListener('fetch', e => {
                e.respondWith(
                    caches.match(e.request).then(res => {
                        return res || fetch(e.request).then(response => {
                            return response;
                        });
                    })
                );
            });
`], {type: 'application/javascript'});
        
        const swUrl = URL.createObjectURL(swBlob);
        navigator.serviceWorker.register(swUrl)
            .then(reg => console.log("Service Worker registered offline successfully!"))
            .catch(err => console.log("Service worker registration skipped: ", err));
    }
}
// Helper to check if both yesterday and today are weekends or holidays in the market's timezone.
// Returns true when markets are closed both yesterday AND today — meaning previous_close should equal current_price.
function checkIfBothDaysAreHolidaysOrWeekends(currency, ticker) {
    const now = new Date();
    const isKoreaStock = /^\d{6}$/.test(ticker) || ticker.endsWith(".KS") || ticker.endsWith(".KQ");
    
    let todayDOW = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    
    try {
        const tz = isKoreaStock ? "Asia/Seoul" : "America/New_York";
        const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
        const dayStr = formatter.format(now);
        const days = { "Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6 };
        if (days[dayStr] !== undefined) {
            todayDOW = days[dayStr];
        }
    } catch (e) {
        console.error("Timezone format error, using local day:", e);
    }
    
    // yesterdayDOW is always (todayDOW - 1 + 7) % 7
    const yesterdayDOW = (todayDOW - 1 + 7) % 7;
    
    // Market is closed on Saturday (6) and Sunday (0)
    const todayIsClosed    = todayDOW === 0 || todayDOW === 6;
    const yesterdayIsClosed = yesterdayDOW === 0 || yesterdayDOW === 6;
    
    // If BOTH today and yesterday are closed days (weekend), there is no new close price vs yesterday.
    // e.g. Saturday (today=6, yesterday=5=Fri → yesterday was open, so return false)
    //      Sunday   (today=0, yesterday=6=Sat → both closed, return true)
    //      Saturday (today=6, yesterday=5 → yesterday was a trading day, return false)
    // Only case where both are closed: Sunday (today) & Saturday (yesterday).
    return todayIsClosed && yesterdayIsClosed;
}

// --------------------------------------------------------------------------
// DYNAMIC STOCK PRICE SYNC ENGINE (YAHOO FINANCE CLIENT-SIDE INTEGRATION)
// --------------------------------------------------------------------------
async function updateStockPrices() {
    const syncBtn = document.getElementById("btn-sync-prices");
    if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 갱신 중...`;
    }
    
    showToast("주가 업데이트", "실시간 환율 및 최신 종가 시세를 불러오는 중입니다...", "info");
    
    let currentRate = assetsData.summary.usd_krw_rate || 1350.0;
    let currentGBPRate = assetsData.summary.gbp_krw_rate || 1720.0;
    
    // 1. Fetch live USD & GBP rates in parallel from Yahoo Finance
    try {
        const usdUrl = `https://query1.finance.yahoo.com/v8/finance/chart/USDKRW=X?ts=${Date.now()}`;
        const gbpUrl = `https://query1.finance.yahoo.com/v8/finance/chart/GBPKRW=X?ts=${Date.now()}`;
        
        const [usdRes, gbpRes] = await Promise.all([
            fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(usdUrl)}`),
            fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(gbpUrl)}`)
        ]);
        
        if (usdRes.ok) {
            const outer = await usdRes.json();
            const data = JSON.parse(outer.contents);
            if (data && data.chart && data.chart.result && data.chart.result[0]) {
                const fetched = data.chart.result[0].meta.regularMarketPrice;
                if (fetched) {
                    currentRate = fetched;
                    assetsData.summary.usd_krw_rate = currentRate;
                    console.log("Dynamically synced USD/KRW Rate:", currentRate);
                }
            }
        }
        
        if (gbpRes.ok) {
            const outer = await gbpRes.json();
            const data = JSON.parse(outer.contents);
            if (data && data.chart && data.chart.result && data.chart.result[0]) {
                const fetched = data.chart.result[0].meta.regularMarketPrice;
                if (fetched) {
                    currentGBPRate = fetched;
                    assetsData.summary.gbp_krw_rate = currentGBPRate;
                    console.log("Dynamically synced GBP/KRW Rate:", currentGBPRate);
                }
            }
        }
    } catch (e) {
        console.error("Failed to fetch dynamic exchange rates in parallel, using backup:", e);
    }
    
    let updatedCount = 0;
    
    // 2. Fetch prices for each stock in parallel to make it extremely fast!
    const pricePromises = assetsData.stocks.map(async (stock) => {
        let yahooTicker = stock.ticker;
        
        // Map Korean stocks to Yahoo format (.KS) if they are digit-only tickers
        if (stock.currency === "KRW" && /^\d+$/.test(stock.ticker)) {
            yahooTicker = stock.ticker + ".KS";
        }
        // Map Berkshire Hathaway ticker to Yahoo format
        if (stock.ticker === "BRK.B") {
            yahooTicker = "BRK-B";
        }
        
        try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?ts=${Date.now()}`;
            const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
            
            const response = await fetch(proxyUrl);
            if (!response.ok) return;
            
            const outerData = await response.json();
            const data = JSON.parse(outerData.contents);
            
            if (data && data.chart && data.chart.result && data.chart.result[0]) {
                const meta = data.chart.result[0].meta;
                let latestPrice = meta.regularMarketPrice;
                let previousClose = meta.chartPreviousClose || meta.previousClose;
                
                if (latestPrice) {
                    let finalPrice = latestPrice;
                    // If it is a US stock but stored in KRW format, convert to KRW using live rate
                    if (!yahooTicker.endsWith(".KS") && stock.currency === "KRW") {
                        finalPrice = latestPrice * currentRate;
                    }
                    
                    // Assign rounded values
                    if (stock.currency === "KRW") {
                        stock.current_price = Math.round(finalPrice);
                    } else {
                        stock.current_price = Math.round(finalPrice * 100) / 100;
                    }
                    
                    // Save previous close dynamically too!
                    if (previousClose) {
                        let finalPrevClose = previousClose;
                        if (!yahooTicker.endsWith(".KS") && stock.currency === "KRW") {
                            finalPrevClose = previousClose * currentRate;
                        }
                        if (stock.currency === "KRW") {
                            stock.previous_close = Math.round(finalPrevClose);
                        } else {
                            stock.previous_close = Math.round(finalPrevClose * 100) / 100;
                        }
                    }
                    

                    
                    updatedCount++;
                }
            }
        } catch (err) {
            console.error(`Failed to update price for ${stock.name}:`, err);
        }
    });
    
    await Promise.all(pricePromises);
    
    // 3. Complete and notify
    if (syncBtn) {
        syncBtn.disabled = false;
        syncBtn.innerHTML = `<i class="fa-solid fa-rotate"></i> 시세 갱신`;
    }
    
    if (updatedCount > 0) {
        saveLocalStorageData();
        showToast(
            "시세 동기화 완료", 
            `실시간 환율(달러: ₩${Math.round(currentRate).toLocaleString()}, 파운드: ₩${Math.round(currentGBPRate).toLocaleString()}) 및 ${updatedCount}개 종목 최신 시세가 반영되었습니다!`, 
            "success"
        );
    } else {
        showToast("시세 동기화 실패", "인터넷 연결 상태를 확인하거나 잠시 후 다시 시도해 주세요.", "error");
    }
}

// Initial setup on Window Load
window.addEventListener("DOMContentLoaded", () => {
    // 1. Initial Local Data Fetch
    loadLocalStorageData();

    // 1.1 Initialize App Theme Engine
    const savedTheme = assetsData.summary.app_theme || "light";
    setAppTheme(savedTheme);

    // 2. Setup Navbar
    initTabNavigation();

    // 3. Setup currency switcher event
    const currencyToggle = document.getElementById("currency-toggle");
    if (currencyToggle) {
        currencyToggle.addEventListener("change", (e) => {
            const labels = document.querySelectorAll(".currency-label");
            if (e.target.checked) {
                activeCurrency = "KRW";
                labels[0].classList.remove("active");
                labels[1].classList.add("active");
            } else {
                activeCurrency = "USD";
                labels[1].classList.remove("active");
                labels[0].classList.add("active");
            }
            updateUI();
        });
    }

    // 6. Setup Backup and Restore system
    setupBackupAndRestore();

    // 7. Register Service Worker for offline PWA installation
    registerServiceWorkerLocal();

    // 7.1 Auto calculation for manual transaction amount
    const txQtyInput = document.getElementById("input-tx-qty");
    const txPriceInput = document.getElementById("input-tx-price");
    const txAmountInput = document.getElementById("input-tx-amount");
    
    function updateAutoTxAmount() {
        const qty = parseFloat(txQtyInput.value) || 0;
        const price = parseFloat(txPriceInput.value) || 0;
        txAmountInput.value = Math.round(qty * price);
    }
    if (txQtyInput && txPriceInput) {
        txQtyInput.addEventListener("input", updateAutoTxAmount);
        txPriceInput.addEventListener("input", updateAutoTxAmount);
    }

    // 7.2 Bind Stock Price Sync Button
    const syncBtn = document.getElementById("btn-sync-prices");
    if (syncBtn) {
        syncBtn.addEventListener("click", updateStockPrices);
    }

    // Auto-fill brokerage/account number when typing stock name
    const assetInput = document.getElementById("input-tx-asset-name");
    if (assetInput) {
        assetInput.addEventListener("input", (e) => {
            const val = e.target.value.trim().toLowerCase();
            if (!val) return;
            const matched = assetsData.stocks.find(s => s.name.toLowerCase() === val);
            if (matched && matched.brokerage) {
                document.getElementById("input-tx-brokerage").value = matched.brokerage;
            }
        });
    }

    // 8.5 Immediately render the UI synchronously so the app loads instantly!
    updateUI();

    // 9. Auto-fetch real-time exchange rates in the background immediately
    autoFetchExchangeRates();
    
    // 9.1 Keep exchange rates fresh - re-fetch every 5 minutes automatically
    setInterval(autoFetchExchangeRates, 5 * 60 * 1000);
});

// ==========================================================================
// 2ND UX OVERHAUL - PREMIUM APP ENGINE COMPONENT FUNCTIONS
// ==========================================================================

// --- Theme Change Engine ---
function setAppTheme(theme) {
    const dots = document.querySelectorAll(".theme-dot");
    dots.forEach(dot => {
        dot.classList.remove("active");
        if (dot.classList.contains(`theme-${theme}`)) {
            dot.classList.add("active");
        }
    });

    document.body.className = "";
    if (theme !== "obsidian") {
        document.body.classList.add(`theme-${theme}`);
    }
    
    if (assetsData && assetsData.summary) {
        assetsData.summary.app_theme = theme;
        localStorage.setItem("antigravity_assets_data", JSON.stringify(assetsData));
    }
}

// --- Manual Exchange Rate Controller ---
function openExchangeRateModal() {
    const usdVal = assetsData.summary.usd_krw_rate || 1350.0;
    const gbpVal = assetsData.summary.gbp_krw_rate || 1720.0;
    
    document.getElementById("slider-usd-krw").value = Math.round(usdVal);
    document.getElementById("input-usd-krw").value = Math.round(usdVal);
    document.getElementById("val-usd-slider").textContent = Math.round(usdVal).toLocaleString() + "원";
    
    document.getElementById("slider-gbp-krw").value = Math.round(gbpVal);
    document.getElementById("input-gbp-krw").value = Math.round(gbpVal);
    document.getElementById("val-gbp-slider").textContent = Math.round(gbpVal).toLocaleString() + "원";
    
    openModal("modal-edit-rates");
}

function submitExchangeRates() {
    const usdRate = parseFloat(document.getElementById("input-usd-krw").value) || 1350.0;
    const gbpRate = parseFloat(document.getElementById("input-gbp-krw").value) || 1720.0;
    
    assetsData.summary.usd_krw_rate = usdRate;
    assetsData.summary.gbp_krw_rate = gbpRate;
    
    closeModal("modal-edit-rates");
    saveLocalStorageData();
    showToast("환율 반영 완료", "수동으로 조정한 환율에 맞춰 전체 평가액이 재산출되었습니다!");
}

// --- Stock Cards Detailed Bottom Sheet Drawer ---
let activeDrawerStockId = null;

function openStockDrawer(stock) {
    activeDrawerStockId = stock.id;
    const rate = assetsData.summary.usd_krw_rate || 1350.0;
    
    document.getElementById("drawer-stock-icon").innerHTML = getInstitutionIcon(stock.brokerage);
    document.getElementById("drawer-stock-name").textContent = stock.name;
    
    const brokerageBadge = document.getElementById("drawer-stock-brokerage");
    if (brokerageBadge) {
        brokerageBadge.style.display = "none";
    }

    const purchaseTotal = stock.quantity * stock.avg_purchase_price;
    const currentTotal = stock.quantity * stock.current_price;
    const profitVal = currentTotal - purchaseTotal;
    const profitPct = purchaseTotal > 0 ? (profitVal / purchaseTotal) * 100 : 0;
    const isProfit = profitVal >= 0;
    
    document.getElementById("drawer-current-price").innerHTML = formatCurrencyDual(stock.current_price, stock.currency);
    
    const dailyBadge = document.getElementById("drawer-daily-change");
    const prevCloseLabel = document.getElementById("drawer-prev-close-text");
    
    if (stock.previous_close) {
        const dailyDiff = stock.current_price - stock.previous_close;
        const dailyPct = (dailyDiff / stock.previous_close) * 100;
        const isUp = dailyDiff > 0;
        const isDown = dailyDiff < 0;
        
        dailyBadge.className = "price-change-badge flat";
        if (isUp) {
            dailyBadge.textContent = `▲${dailyPct.toFixed(2)}%`;
            dailyBadge.classList.add("up");
        } else if (isDown) {
            dailyBadge.textContent = `▼${Math.abs(dailyPct).toFixed(2)}%`;
            dailyBadge.classList.add("down");
        } else {
            dailyBadge.textContent = "0.00%";
        }
        prevCloseLabel.innerHTML = `어제 ${formatCurrencyDual(stock.previous_close, stock.currency)}`;
    } else {
        dailyBadge.textContent = "0.00%";
        dailyBadge.className = "price-change-badge flat";
        prevCloseLabel.textContent = "-";
    }
    
    const profitAmountEl = document.getElementById("drawer-profit-amount");
    const profitPercentEl = document.getElementById("drawer-profit-percent");
    
    profitAmountEl.className = isProfit ? "drawer-profit-amount text-success" : "drawer-profit-amount text-danger";
    profitPercentEl.className = isProfit ? "drawer-profit-percent text-success" : "drawer-profit-percent text-danger";
    
    profitAmountEl.innerHTML = `${isProfit ? '+' : ''}${formatCurrencyDual(profitVal, stock.currency)}`;
    profitPercentEl.textContent = `${isProfit ? '+' : ''}${profitPct.toFixed(2)}%`;

    document.getElementById("drawer-stat-qty").textContent = `${stock.quantity.toLocaleString()}주`;
    document.getElementById("drawer-stat-avg-price").innerHTML = formatCurrencyDual(stock.avg_purchase_price, stock.currency);
    document.getElementById("drawer-stat-purchase-total").innerHTML = formatCurrencyDual(purchaseTotal, stock.currency);
    document.getElementById("drawer-stat-current-total").innerHTML = formatCurrencyDual(currentTotal, stock.currency);

    // Clear sparkline path/area/dots & set range to "조회 중..."
    const chartRangeEl = document.getElementById("drawer-chart-range");
    if (chartRangeEl) chartRangeEl.textContent = "조회 중...";
    
    document.getElementById("sparkline-path").setAttribute("d", "");
    document.getElementById("sparkline-area").setAttribute("d", "");
    document.getElementById("sparkline-dots").innerHTML = "";

    // Fetch real-time historical prices for past 5 days
    fetchReal5DayHistory(stock);

    // Populate direct edit form
    const qtyInput = document.getElementById("edit-stock-qty");
    const priceInput = document.getElementById("edit-stock-price");
    const currencySelect = document.getElementById("edit-stock-currency");
    const tickerInput = document.getElementById("edit-stock-ticker");
    
    if (qtyInput) qtyInput.value = stock.quantity;
    if (priceInput) priceInput.value = stock.avg_purchase_price;
    if (currencySelect) currencySelect.value = stock.currency || "KRW";
    if (tickerInput) tickerInput.value = stock.ticker;
    
    // Collapse edit form initially
    const editForm = document.getElementById("drawer-edit-form");
    const editChevron = document.getElementById("drawer-edit-chevron");
    if (editForm) editForm.style.display = "none";
    if (editChevron) editChevron.style.transform = "rotate(0deg)";

    document.getElementById("stock-detail-drawer").style.display = "flex";
}

function closeStockDrawer(event) {
    if (!event || event.target === document.getElementById("stock-detail-drawer")) {
        document.getElementById("stock-detail-drawer").style.display = "none";
    }
}

function handleDrawerDeleteStock() {
    if (!activeDrawerStockId) return;
    
    const stock = assetsData.stocks.find(s => s.id === activeDrawerStockId);
    if (!stock) return;
    
    if (confirm(`[${stock.brokerage}] ${stock.name} 주식을 정말로 포트폴리오에서 삭제하시겠습니까?`)) {
        assetsData.stocks = assetsData.stocks.filter(s => 
            !(s.id === activeDrawerStockId || 
              s.name.trim().toLowerCase() === stock.name.trim().toLowerCase() || 
              (s.ticker && stock.ticker && s.ticker.trim().toLowerCase() === stock.ticker.trim().toLowerCase()))
        );
        document.getElementById("stock-detail-drawer").style.display = "none";
        saveLocalStorageData();
        showToast("삭제 완료", "주식 항목이 포트폴리오에서 삭제되었습니다.");
    }
}

// Toggle display of the direct edit form inside the stock drawer
function toggleDrawerEditForm() {
    const form = document.getElementById("drawer-edit-form");
    const chevron = document.getElementById("drawer-edit-chevron");
    if (!form || !chevron) return;
    
    if (form.style.display === "none") {
        form.style.display = "block";
        chevron.style.transform = "rotate(180deg)";
    } else {
        form.style.display = "none";
        chevron.style.transform = "rotate(0deg)";
    }
}

// Save direct manual edits to a stock from the drawer form
function saveDrawerStockEdit() {
    if (!activeDrawerStockId) return;
    
    const stock = assetsData.stocks.find(s => s.id === activeDrawerStockId);
    if (!stock) return;
    
    const qty = parseFloat(document.getElementById("edit-stock-qty").value);
    const price = parseFloat(document.getElementById("edit-stock-price").value);
    const currency = document.getElementById("edit-stock-currency").value;
    const ticker = document.getElementById("edit-stock-ticker").value.trim().toUpperCase();
    
    if (isNaN(qty) || qty <= 0) {
        showToast("입력 오류", "유효한 보유 수량을 입력해 주세요.", "error");
        return;
    }
    if (isNaN(price) || price < 0) {
        showToast("입력 오류", "유효한 평단가를 입력해 주세요.", "error");
        return;
    }
    if (!ticker) {
        showToast("입력 오류", "유효한 티커를 입력해 주세요.", "error");
        return;
    }
    
    // Consolidated deduplication during manual edit to purge any duplicate garbage rows
    assetsData.stocks = assetsData.stocks.filter(s => 
        s.id === activeDrawerStockId || 
        !(s.name.trim().toLowerCase() === stock.name.trim().toLowerCase() || 
          (s.ticker && stock.ticker && s.ticker.trim().toLowerCase() === stock.ticker.trim().toLowerCase()))
    );

    stock.quantity = qty;
    stock.avg_purchase_price = price;
    stock.currency = currency;
    stock.ticker = ticker;
    
    saveLocalStorageData();
    showToast("정보 수정 완료", `[${stock.name}] 자산 정보가 포트폴리오에 성공적으로 저장되었습니다!`, "success");
    
    // Close the drawer and reopen to refresh details immediately
    document.getElementById("stock-detail-drawer").style.display = "none";
    setTimeout(() => {
        openStockDrawer(stock);
    }, 100);
}

// Fetch actual 5-day historical prices from Yahoo Finance
async function fetchReal5DayHistory(stock) {
    const rate = assetsData.summary.usd_krw_rate || 1350.0;
    let yahooTicker = stock.ticker;
    
    // Map Korean stocks to Yahoo format (.KS) if they are digit-only tickers
    if (stock.currency === "KRW" && /^\d+$/.test(stock.ticker)) {
        yahooTicker = stock.ticker + ".KS";
    }
    // Map Berkshire Hathaway ticker to Yahoo format
    if (stock.ticker === "BRK.B") {
        yahooTicker = "BRK-B";
    }
    
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?range=5d&interval=1d&ts=${Date.now()}`;
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        
        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error("Network response error");
        
        const outerData = await response.json();
        const data = JSON.parse(outerData.contents);
        
        if (data && data.chart && data.chart.result && data.chart.result[0]) {
            const result = data.chart.result[0];
            const timestamps = result.timestamp || [];
            const closePrices = result.indicators.quote[0].close || [];
            
            // Filter out null/undefined prices
            const validPoints = [];
            const validLabels = [];
            
            for (let i = 0; i < closePrices.length; i++) {
                if (closePrices[i] !== null && closePrices[i] !== undefined) {
                    let price = closePrices[i];
                    // If it is a US stock but stored in KRW format, convert to KRW using live rate
                    if (!yahooTicker.endsWith(".KS") && stock.currency === "KRW") {
                        price = price * rate;
                    }
                    validPoints.push(price);
                    
                    if (timestamps[i]) {
                        const date = new Date(timestamps[i] * 1000);
                        validLabels.push(`${date.getMonth() + 1}/${date.getDate()}`);
                    }
                }
            }
            
            // Make sure the last price maps to the current_price exactly
            if (validPoints.length > 0 && stock.current_price) {
                validPoints[validPoints.length - 1] = stock.current_price;
            }
            
            if (validPoints.length >= 2) {
                drawSparkline(validPoints);
                
                const chartRangeEl = document.getElementById("drawer-chart-range");
                if (chartRangeEl && validLabels.length >= 2) {
                    const startLabel = validLabels[0];
                    const endLabel = validLabels[validLabels.length - 1];
                    chartRangeEl.textContent = `${startLabel} ~ ${endLabel}`;
                }
                return;
            }
        }
        throw new Error("Invalid chart data");
    } catch (e) {
        console.error(`Failed to fetch 5d history for ${stock.name}:`, e);
        // Fallback to simulated sparkline using yesterday's close and current price
        const chartRangeEl = document.getElementById("drawer-chart-range");
        if (chartRangeEl) chartRangeEl.textContent = "일시적 데이터";
        const simulatedPoints = generateSparklineData(stock.previous_close || stock.avg_purchase_price, stock.current_price);
        drawSparkline(simulatedPoints);
    }
}

// 5-day Sparkline path and coords generator
function generateSparklineData(prevPrice, currPrice) {
    const points = [];
    points.push(prevPrice);
    const step = (currPrice - prevPrice) / 4;
    for (let i = 1; i <= 3; i++) {
        const interp = prevPrice + step * i;
        const noise = (Math.random() - 0.5) * 0.02 * currPrice;
        points.push(Math.max(0, interp + noise));
    }
    points.push(currPrice);
    return points;
}

function drawSparkline(points) {
    const minVal = Math.min(...points) * 0.995;
    const maxVal = Math.max(...points) * 1.005;
    const valRange = maxVal - minVal || 1;
    
    const svgWidth = 300;
    const svgHeight = 60;
    
    const coords = points.map((val, idx) => {
        const x = (idx / (points.length - 1)) * svgWidth;
        const y = svgHeight - ((val - minVal) / valRange) * svgHeight;
        return { x, y };
    });
    
    let pathD = `M ${coords[0].x} ${coords[0].y}`;
    for (let i = 1; i < coords.length; i++) {
        pathD += ` L ${coords[i].x} ${coords[i].y}`;
    }
    
    const areaD = `${pathD} L ${coords[coords.length - 1].x} ${svgHeight} L ${coords[0].x} ${svgHeight} Z`;
    
    document.getElementById("sparkline-path").setAttribute("d", pathD);
    document.getElementById("sparkline-area").setAttribute("d", areaD);
    
    const dotsContainer = document.getElementById("sparkline-dots");
    dotsContainer.innerHTML = "";
    coords.forEach((coord, idx) => {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", coord.x.toString());
        circle.setAttribute("cy", coord.y.toString());
        circle.setAttribute("r", idx === coords.length - 1 ? "4" : "2");
        circle.setAttribute("fill", idx === coords.length - 1 ? "#ec4899" : "var(--color-primary)");
        circle.setAttribute("stroke", "#ffffff");
        circle.setAttribute("stroke-width", idx === coords.length - 1 ? "1.5" : "1");
        dotsContainer.appendChild(circle);
    });
}

// --- Sector Classification Engine ---
function getSectorForAsset(item, type) {
    
    
    const ticker = item.ticker || "";
    const name = item.name || "";
    
    if (ticker === "NVDA" || ticker === "AAPL" || ticker === "TSLA" || ticker === "QQQ" ||
        ticker === "005930" || ticker === "418660" || ticker === "465580" || 
        name.includes("삼성전자") || name.includes("나스닥") || name.includes("빅테크") || name.includes("NVIDIA") || name.includes("Apple") || name.includes("Tesla")) {
        return "IT 기술주 & 성장주";
    }
    
    if (ticker === "SGOL" || name.includes("골드") || name.includes("금") || name.includes("Gold")) {
        return "안전자산 & 금";
    }
    
    return "가치주 & 배당주";
}

// --- Analysis Subviews Gauges drawing ---
let activeAnalysisView = "stock";

function switchAnalysisView(view) {
    activeAnalysisView = view;
    
    const btns = document.querySelectorAll("#tab-analysis .filters-container .filter-btn");
    btns.forEach(btn => {
        btn.classList.remove("active");
    });
    
    document.getElementById(`btn-analysis-${view}`).classList.add("active");
    
    document.getElementById("analysis-stock-view").style.display = view === "stock" ? "block" : "none";
    document.getElementById("analysis-country-view").style.display = view === "country" ? "block" : "none";
    document.getElementById("analysis-sector-view").style.display = view === "sector" ? "block" : "none";
    document.getElementById("analysis-account-view").style.display = view === "account" ? "block" : "none";
    
    renderAnalysisViews();
}

function renderAnalysisViews() {
    const rate = assetsData.summary.usd_krw_rate || 1350.0;
    
    const totalStocksKRW = calcTotalKRW();
    const grandTotal = totalStocksKRW;

    renderAnalysisDonutChart(totalStocksKRW);

    const countryContainer = document.getElementById("analysis-country-list");
    if (countryContainer) {
        countryContainer.innerHTML = "";
        
        let krwTotal = 0;
        let usdTotal = 0;
        
        assetsData.stocks.forEach(item => {
            const val = item.quantity * item.current_price * (item.currency === "USD" ? rate : 1);
            const isUS = item.currency === "USD" || 
                         (item.name && item.name.match(/미국|나스닥|S&P|다우존스|빅테크|애플|엔비디아|테슬라/i)) || 
                         item.ticker === "418660" || item.ticker === "465580" || item.ticker === "458730";
                         
            if (isUS) usdTotal += val;
            else krwTotal += val;
        });
        
        const krwPct = grandTotal > 0 ? (krwTotal / grandTotal) * 100 : 0;
        const usdPct = grandTotal > 0 ? (usdTotal / grandTotal) * 100 : 0;
        
        const krwItem = document.createElement("div");
        krwItem.className = "gauge-item";
        krwItem.innerHTML = `
            <div class="gauge-meta">
                <span class="gauge-label">🇰🇷 대한민국 원화 자산 (KRW)</span>
                <span class="gauge-percentage">${Math.round(krwPct)}%</span>
            </div>
            <div class="gauge-track">
                <div class="gauge-fill" style="width: 0%; background: linear-gradient(90deg, var(--color-primary) 0%, var(--color-accent) 100%);"></div>
            </div>
            <div class="gauge-details">
                <span>원화 평가액</span>
                <span style="font-weight: 600; color: var(--text-main);">${formatCurrency(krwTotal, "KRW")}</span>
            </div>
        `;
        countryContainer.appendChild(krwItem);
        
        const usdItem = document.createElement("div");
        usdItem.className = "gauge-item";
        usdItem.innerHTML = `
            <div class="gauge-meta">
                <span class="gauge-label">🇺🇸 미국 달러 자산 (USD)</span>
                <span class="gauge-percentage">${Math.round(usdPct)}%</span>
            </div>
            <div class="gauge-track">
                <div class="gauge-fill" style="width: 0%; background: linear-gradient(90deg, #f59e0b 0%, #facc15 100%);"></div>
            </div>
            <div class="gauge-details">
                <span>달러 평가액</span>
                <span style="font-weight: 600; color: var(--text-main);">${formatCurrency(usdTotal, "KRW")}</span>
            </div>
        `;
        countryContainer.appendChild(usdItem);
        
        setTimeout(() => {
            krwItem.querySelector(".gauge-fill").style.width = `${krwPct}%`;
            usdItem.querySelector(".gauge-fill").style.width = `${usdPct}%`;
        }, 100);
    }

    
    // Render Account Allocation Breakdown
    const accountContainer = document.getElementById("analysis-account-list");
    if (accountContainer) {
        accountContainer.innerHTML = "";
        
        const accountSums = {};
        assetsData.stocks.forEach(item => {
            const val = item.quantity * item.current_price * (item.currency === "USD" ? rate : 1);
            const acc = item.brokerage || "기본계좌";
            accountSums[acc] = (accountSums[acc] || 0) + val;
        });
        
        const getAccountGradient = (index) => {
            const hues = [210, 280, 45, 150, 330, 190];
            const h = hues[index % hues.length];
            return `linear-gradient(90deg, hsl(${h}, 80%, 65%) 0%, hsl(${h}, 80%, 45%) 100%)`;
        };
        
        const sortedAccounts = Object.entries(accountSums).sort((a, b) => b[1] - a[1]);
        
        sortedAccounts.forEach(([accName, accVal], idx) => {
            const pct = grandTotal > 0 ? (accVal / grandTotal) * 100 : 0;
            if (accVal <= 0) return;
            
            const accItem = document.createElement("div");
            accItem.className = "gauge-item";
            
            const iconHtml = getInstitutionIcon(accName);
            
            accItem.innerHTML = `
                <div class="gauge-meta">
                    <span class="gauge-label">${iconHtml} ${accName}</span>
                    <span class="gauge-percentage">${Math.round(pct)}%</span>
                </div>
                <div class="gauge-track">
                    <div class="gauge-fill" style="width: 0%; background: ${getAccountGradient(idx)};"></div>
                </div>
                <div class="gauge-details">
                    <span>원화 환산 평가액</span>
                    <span style="font-weight: 600; color: var(--text-main);">${formatCurrency(accVal, "KRW")}</span>
                </div>
            `;
            accountContainer.appendChild(accItem);
            
            setTimeout(() => {
                const fill = accItem.querySelector(".gauge-fill");
                if (fill) fill.style.width = `${pct}%`;
            }, 100);
        });
    }

    const sectorContainer = document.getElementById("analysis-sector-list");
    if (sectorContainer) {
        sectorContainer.innerHTML = "";
        
        const sectorSums = {
            "IT 기술주 & 성장주": 0,
            "가치주 & 배당주": 0,
            "안전자산 & 금": 0,
            "현금성 자산": 0
        };
        
        assetsData.stocks.forEach(item => {
            const val = item.quantity * item.current_price * (item.currency === "USD" ? rate : 1);
            const sec = getSectorForAsset(item, "stock");
            if (sectorSums[sec] !== undefined) sectorSums[sec] += val;
        });
        
        const sectorColors = {
            "IT 기술주 & 성장주": "linear-gradient(90deg, #00d2ff 0%, #0066ff 100%)",
            "가치주 & 배당주": "linear-gradient(90deg, #a78bfa 0%, #8b5cf6 100%)",
            "안전자산 & 금": "linear-gradient(90deg, #facc15 0%, #eab308 100%)",
            "현금성 자산": "linear-gradient(90deg, #10b981 0%, #059669 100%)"
        };
        
        const sectorIcons = {
            "IT 기술주 & 성장주": "<i class='fa-solid fa-microchip' style='color:#00d2ff'></i>",
            "가치주 & 배당주": "<i class='fa-solid fa-gift' style='color:#a78bfa'></i>",
            "안전자산 & 금": "<i class='fa-solid fa-coins' style='color:#facc15'></i>",
            "현금성 자산": "<i class='fa-solid fa-wallet' style='color:#10b981'></i>"
        };
        
        const sortedSectors = Object.entries(sectorSums).sort((a, b) => b[1] - a[1]);
        
        sortedSectors.forEach(([secName, secVal]) => {
            const pct = grandTotal > 0 ? (secVal / grandTotal) * 100 : 0;
            if (secVal <= 0) return;
            
            const secItem = document.createElement("div");
            secItem.className = "gauge-item";
            secItem.innerHTML = `
                <div class="gauge-meta">
                    <span class="gauge-label">${sectorIcons[secName]} ${secName}</span>
                    <span class="gauge-percentage">${Math.round(pct)}%</span>
                </div>
                <div class="gauge-track">
                    <div class="gauge-fill" style="width: 0%; background: ${sectorColors[secName]};"></div>
                </div>
                <div class="gauge-details">
                    <span>원화 환산 평가액</span>
                    <span style="font-weight: 600; color: var(--text-main);">${formatCurrency(secVal, "KRW")}</span>
                </div>
            `;
            sectorContainer.appendChild(secItem);
            
            setTimeout(() => {
                secItem.querySelector(".gauge-fill").style.width = `${pct}%`;
            }, 100);
        });
    }
}

function renderAnalysisDonutChart(stocksTotal) {
    const segmentsContainer = document.getElementById("analysis-donut-segments");
    const legendContainer = document.getElementById("analysis-chart-legend-container");
    const centerPercentText = document.getElementById("analysis-chart-center-percentage");

    if (!segmentsContainer || !legendContainer) return;

    segmentsContainer.innerHTML = "";
    legendContainer.innerHTML = "";

    if (stocksTotal === 0) {
        centerPercentText.textContent = "0%";
        return;
    }

    const colors = [
        "#00d2ff", "#a78bfa", "#facc15", "#10b981", 
        "#f43f5e", "#38bdf8", "#c084fc", "#ec4899",
        "#f97316", "#3b82f6", "#14b8a6", "#8b5cf6"
    ];

    const segments = [];
    const rate = assetsData.summary.usd_krw_rate || 1350.0;
    
    const displayStocks = mergeDuplicateStocks(assetsData.stocks);
    displayStocks.forEach((item, idx) => {
        const val = item.quantity * item.current_price * (item.currency === "USD" ? rate : 1);
        segments.push({
            name: item.name,
            value: val,
            color: colors[idx % colors.length],
            class: `analysis-stock-${idx}`
        });
    });

    segments.sort((a, b) => b.value - a.value);

    let currentOffset = 0;
    const radius = 80;
    const circumference = 2 * Math.PI * radius;

    segments.forEach((seg) => {
        const percentage = seg.value / stocksTotal;
        const strokeLength = percentage * circumference;
        const targetOffset = -currentOffset;

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", "110");
        circle.setAttribute("cy", "110");
        circle.setAttribute("r", radius.toString());
        circle.className.baseVal = `donut-segment ${seg.class}`;
        circle.setAttribute("stroke", seg.color);
        
        circle.setAttribute("stroke-dasharray", `${strokeLength} ${circumference}`);
        circle.setAttribute("stroke-dashoffset", circumference.toString());
        
        setTimeout(() => {
            circle.setAttribute("stroke-dashoffset", targetOffset.toString());
        }, 50);

        segmentsContainer.appendChild(circle);
        
        currentOffset += strokeLength;

        if (seg.value > 0) {
            const legendItem = document.createElement("div");
            legendItem.className = "legend-item";
            legendItem.innerHTML = `
                <span class="legend-color" style="background: ${seg.color}"></span>
                <span class="legend-name">${seg.name}</span>
                <span class="legend-val">${Math.round(percentage * 100)}%</span>
            `;
            legendContainer.appendChild(legendItem);
        }
    });

    centerPercentText.textContent = `${assetsData.stocks.length}개`;
    const labelEl = document.querySelector("#analysis-donut-container .chart-center-label");
    if (labelEl) labelEl.textContent = "보유 종목";
}

// --- Luxury Digital Statement Receipts Modal ---
let activeReceiptTxId = null;
let activeEditTxId = null;


function openEditTxModal(tx) {
    activeEditTxId = tx.id;
    
    document.getElementById("input-tx-category").value = tx.category;
    toggleTxCategoryFields();
    
    document.getElementById("input-tx-type").value = tx.type;
    document.getElementById("input-tx-brokerage").value = tx.brokerage_or_bank || "";
    document.getElementById("input-tx-asset-name").value = tx.asset_name || "";
    document.getElementById("input-tx-currency").value = tx.currency || "KRW";
    
    if (tx.category === "stock") {
        document.getElementById("input-tx-qty").value = tx.quantity || "";
        document.getElementById("input-tx-price").value = tx.price || "";
        document.getElementById("input-tx-amount").value = tx.amount || "";
    } else {
        document.getElementById("input-tx-amount").value = tx.amount || "";
    }
    
    const modalTitle = document.querySelector("#modal-add-tx .modal-title");
    if (modalTitle) modalTitle.textContent = "거래 내역 수정";
    
    const submitBtn = document.querySelector("#modal-add-tx .btn-primary");
    if (submitBtn) {
        submitBtn.innerHTML = `<i class="fa-solid fa-circle-check"></i> 수정 완료`;
    }
    
    openModal("modal-add-tx");
}

function openTxReceipt(tx) {
    activeReceiptTxId = tx.id;
    
    let dateStr = tx.date;
    try {
        const d = new Date(tx.date);
        dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    } catch(e) {}
    
    document.getElementById("receipt-date").textContent = dateStr;
    document.getElementById("receipt-tx-id").textContent = tx.id.toUpperCase();
    document.getElementById("receipt-brokerage").textContent = tx.brokerage_or_bank;
    
    let typeLabel = "입금";
    if (tx.type === "buy") typeLabel = "매수";
    else if (tx.type === "sell") typeLabel = "매도";
    else if (tx.type === "withdraw") typeLabel = "출금";
    
    document.getElementById("receipt-item-name").textContent = `${tx.asset_name} ${typeLabel}`;
    document.getElementById("receipt-total-amount").innerHTML = formatCurrency(tx.amount, tx.currency);
    
    const subEl = document.getElementById("receipt-sub-details");
    if (tx.category === "stock") {
        subEl.innerHTML = `${tx.quantity.toLocaleString()}주 × ${formatCurrency(tx.price, tx.currency)}`;
        subEl.style.display = "block";
    } else {
        subEl.style.display = "none";
    }
    
    document.getElementById("receipt-memo-input").value = tx.memo || "";
    
    const numericOnly = tx.id.replace(/[^0-9]/g, '');
    const barcodeText = numericOnly ? numericOnly.slice(0, 14).padEnd(14, '0') : "20260523" + String(Math.floor(Math.random()*1000000)).padStart(6, '0');
    document.getElementById("receipt-barcode-text").textContent = barcodeText;
    
    const btnEdit = document.getElementById("btn-edit-tx-trigger");
    if (btnEdit) {
        const newBtn = btnEdit.cloneNode(true);
        btnEdit.parentNode.replaceChild(newBtn, btnEdit);
        newBtn.addEventListener("click", () => {
            closeModal("modal-tx-receipt");
            openEditTxModal(tx);
        });
    }
    
    openModal("modal-tx-receipt");
}

function saveReceiptMemo() {
    if (!activeReceiptTxId) return;
    
    const memoVal = document.getElementById("receipt-memo-input").value.trim();
    
    for (let tx of assetsData.transactions) {
        if (tx.id === activeReceiptTxId) {
            tx.memo = memoVal;
            break;
        }
    }
    
    closeModal("modal-tx-receipt");
    saveLocalStorageData();
    showToast("메모 저장 완료", "거래 영수증에 메모가 성공적으로 기록되었습니다.");
}

function resetTxFilters() {
    if (document.getElementById("input-tx-search")) document.getElementById("input-tx-search").value = "";
    if (document.getElementById("input-tx-start")) document.getElementById("input-tx-start").value = "";
    if (document.getElementById("input-tx-end")) document.getElementById("input-tx-end").value = "";
    
    renderTransactions();
    showToast("필터 초기화", "모든 거래 검색 필터가 리셋되었습니다.");
}

// --- Silent Background Real-time Exchange Rates Auto-fetch ---
async function autoFetchExchangeRates() {
    console.log("Auto-fetching real-time exchange rates...");

    // Try multiple CORS proxies in order until one works
    async function fetchRate(yahooSymbol) {
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m&range=1d&ts=${Date.now()}`;
        const proxies = [
            `https://api.allorigins.win/get?url=${encodeURIComponent(yahooUrl)}`,
            `https://corsproxy.io/?${encodeURIComponent(yahooUrl)}`
        ];
        for (const proxyUrl of proxies) {
            try {
                const res = await fetch(proxyUrl);
                if (!res.ok) continue;
                const text = await res.text();
                let parsed;
                try { parsed = JSON.parse(text); } catch { continue; }
                // allorigins wraps in {contents:"..."}, corsproxy returns raw
                const inner = parsed.contents ? JSON.parse(parsed.contents) : parsed;
                const price = inner?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (price && price > 0) return price;
            } catch(e) {
                console.warn(`Proxy failed (${proxyUrl}):`, e.message);
            }
        }
        return null;
    }

    try {
        const [usdRate, gbpRate] = await Promise.all([
            fetchRate("USDKRW=X"),
            fetchRate("GBPKRW=X")
        ]);

        let changed = false;

        if (usdRate && usdRate > 900 && usdRate < 2000) {
            assetsData.summary.usd_krw_rate = Math.round(usdRate * 100) / 100;
            changed = true;
            console.log("USD/KRW synced:", assetsData.summary.usd_krw_rate);
        }

        if (gbpRate && gbpRate > 1000 && gbpRate < 3000) {
            assetsData.summary.gbp_krw_rate = Math.round(gbpRate * 100) / 100;
            changed = true;
            console.log("GBP/KRW synced:", assetsData.summary.gbp_krw_rate);
        }

        if (changed) {
            localStorage.setItem("antigravity_assets_data", JSON.stringify(assetsData));
            updateUI();
        } else {
            console.warn("Exchange rate: no valid data from any proxy.");
        }
    } catch (e) {
        console.error("Exchange rate fetch failed:", e);
    }
}

