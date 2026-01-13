// ==========================================
// CONFIGURATION & STATE
// ==========================================
let COMPASS_MODE = "DEMAND"; 
let trackData = [];
let photoData = [];
let watchID = null;
let tracking = false;
let startTime = null;
let lastPos = null;
let totalDistance = 0;
let timerInterval = null; 
let db = null; // NEW: Database Connection

// ==========================================
// 1. DATABASE & RESTORE LOGIC (INDEXEDDB)
// ==========================================

// Open "The Media Vault" (RunTrackerDB)
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("RunTrackerDB", 1);
        
        request.onupgradeneeded = function(e) {
            const db = e.target.result;
            if (!db.objectStoreNames.contains("photos")) {
                db.createObjectStore("photos", { keyPath: "timestamp" });
            }
        };

        request.onsuccess = function(e) {
            db = e.target.result;
            resolve(db);
        };

        request.onerror = function(e) {
            console.error("DB Error:", e);
            reject(e);
        };
    });
}

// Save a single photo to the Vault
function savePhotoToDB(photoObj) {
    if (!db) return;
    const tx = db.transaction(["photos"], "readwrite");
    const store = tx.objectStore("photos");
    store.add(photoObj);
}

// Load all photos from the Vault (Crash Recovery)
function loadPhotosFromDB() {
    return new Promise((resolve) => {
        if (!db) return resolve([]);
        const tx = db.transaction(["photos"], "readonly");
        const store = tx.objectStore("photos");
        const request = store.getAll();
        
        request.onsuccess = function() {
            resolve(request.result);
        };
    });
}

// Wipe the Vault (Reset)
function clearPhotoDB() {
    if (!db) return;
    const tx = db.transaction(["photos"], "readwrite");
    const store = tx.objectStore("photos");
    store.clear();
}

// --- INITIALIZATION ---
window.onload = async function() {
    await initDB(); // Open Database First
    restoreRunFromMemory(); // Then check for crashes
};

async function restoreRunFromMemory() {
    const savedTrack = localStorage.getItem('run_track');
    const savedDist = localStorage.getItem('run_dist');
    const savedStart = localStorage.getItem('run_start');

    if (savedTrack && savedStart) {
        const resume = confirm("⚠️ CRASH DETECTED ⚠️\nFound an unfinished run.\n\nRestore GPS & Photos?");
        if (resume) {
            // 1. Restore Variables
            trackData = JSON.parse(savedTrack);
            totalDistance = parseFloat(savedDist);
            startTime = parseInt(savedStart);
            
            // 2. Restore Map Path
            const latLngs = trackData.map(p => [p.lat, p.lng]);
            pathLayer.setLatLngs(latLngs);
            if (latLngs.length > 0) {
                map.setView(latLngs[latLngs.length - 1], 16);
                lastPos = { 
                    latitude: latLngs[latLngs.length - 1][0], 
                    longitude: latLngs[latLngs.length - 1][1] 
                };
            }

            // 3. RESTORE PHOTOS FROM DB (The Magic Step)
            const savedPhotos = await loadPhotosFromDB();
            photoData = savedPhotos;
            
            // Re-draw markers on map
            photoData.forEach(p => {
                // Reconstruct image from chunks
                const imgData = p.src_chunks.join("");
                
                const photoIcon = L.divIcon({
                    html: `<div style="background-image: url('${imgData}'); width: 40px; height: 40px;" class="photo-marker"></div>`,
                    className: 'photo-marker-container',
                    iconSize: [44, 44],
                    iconAnchor: [22, 44]
                });

                L.marker([p.lat, p.lng], {icon: photoIcon})
                    .addTo(map)
                    .bindPopup(`<img src="${imgData}" style="width:100px;"><br>Heading: ${p.heading}°`);
            });

            // 4. Restore UI
            document.getElementById('dist').innerText = Math.round(totalDistance);
            toggleTracking(false); 
            document.getElementById('btn-start').innerText = "Resume Run";
            updateUI(false); 
            updateTimeDisplay();
        } else {
            clearMemory();
            clearPhotoDB(); // Wipe DB if user says "No"
        }
    }
}

// ==========================================
// 2. MAP & UTILS
// ==========================================
const map = L.map('map').setView([0, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

const pathLayer = L.polyline([], {color: '#dc3545', weight: 5}).addTo(map);

function saveToMemory() {
    if (!startTime) return;
    try {
        localStorage.setItem('run_track', JSON.stringify(trackData));
        localStorage.setItem('run_dist', totalDistance);
        localStorage.setItem('run_start', startTime);
    } catch (e) {
        console.warn("Storage full! Track path getting too long.");
    }
}

function clearMemory() {
    localStorage.removeItem('run_track');
    localStorage.removeItem('run_dist');
    localStorage.removeItem('run_start');
}

// ==========================================
// 3. TRACKING LOGIC
// ==========================================
function toggleTracking(start) {
    tracking = start;
    updateUI(start);

    if (start) {
        if (!startTime) {
            startTime = Date.now(); 
            saveToMemory(); 
        }
        
        clearInterval(timerInterval);
        timerInterval = setInterval(updateTimeDisplay, 1000);

        if (navigator.geolocation) {
            watchID = navigator.geolocation.watchPosition(
                updatePosition,
                (err) => {
                    console.warn("GPS Error:", err);
                    document.getElementById('dist').innerText = "GPS Lost";
                },
                { enableHighAccuracy: true, maximumAge: 1000 }
            );
        } else {
            console.error("GPS not supported");
        }
        
        if (COMPASS_MODE === "CONTINUOUS") startCompassListener();

    } else {
        if (watchID) navigator.geolocation.clearWatch(watchID);
        watchID = null;
        clearInterval(timerInterval); 
        stopCompassListener();
        saveToMemory(); 
    }
}

function updateTimeDisplay() {
    if (!startTime) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    document.getElementById('time').innerText = `${mins}:${secs}`;
}

function updatePosition(position) {
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    
    if (!lastPos) map.setView([lat, lng], 18);

    let v_current = position.coords.speed || 0;
    
    if (lastPos) {
        const distStep = map.distance([lastPos.latitude, lastPos.longitude], [lat, lng]);
        totalDistance += distStep;
    }

    document.getElementById('vel').innerText = v_current.toFixed(1);
    document.getElementById('dist').innerText = Math.round(totalDistance);
    
    pathLayer.addLatLng([lat, lng]);
    
    trackData.push({
        time: (Date.now() - startTime) / 1000,
        absTime: position.timestamp,
        lat: lat,
        lng: lng,
        vel: v_current
    });

    lastPos = { latitude: lat, longitude: lng, speed: v_current };
    saveToMemory();
}

// ==========================================
// 4. PHOTO LOGIC
// ==========================================
function chunkString(str, length) {
    return str.match(new RegExp('.{1,' + length + '}', 'g'));
}

function addPhotoToTrack(imgData, heading) {
    if (!lastPos) {
        alert("⚠️ GPS Searching... \nWait for map to zoom.");
        return; 
    }

    const lat = lastPos.latitude;
    const lng = lastPos.longitude;

    const photoIcon = L.divIcon({
        html: `<div style="background-image: url('${imgData}'); width: 40px; height: 40px;" class="photo-marker"></div>`,
        className: 'photo-marker-container',
        iconSize: [44, 44],
        iconAnchor: [22, 44]
    });

    L.marker([lat, lng], {icon: photoIcon})
        .addTo(map)
        .bindPopup(`<img src="${imgData}" style="width:100px;"><br>Heading: ${Math.round(heading)}°`);
    
    // Create the photo object
    const newPhoto = {
        lat: lat,
        lng: lng,
        heading: Math.round(heading),
        src_chunks: chunkString(imgData, 100),
        timestamp: Date.now()
    };

    photoData.push(newPhoto);
    
    // NEW: Save to Media Vault immediately
    savePhotoToDB(newPhoto);
}

async function handlePhoto(input) {
    if (input.files && input.files[0]) {
        const file = input.files[0];
        const heading = await getHeadingNow();
        const reader = new FileReader();
        reader.onload = function(e) {
            addPhotoToTrack(e.target.result, heading);
        };
        reader.readAsDataURL(file);
    }
}

// ==========================================
// 5. COMPASS & EXPORT
// ==========================================
function toggleCompassMode() {
    const checkbox = document.getElementById('compass-toggle');
    const label = document.querySelector('.mode-label');
    if (checkbox.checked) {
        COMPASS_MODE = "CONTINUOUS";
        label.innerText = "Mode: Running (Continuous Compass)";
        if (tracking) startCompassListener();
    } else {
        COMPASS_MODE = "DEMAND";
        label.innerText = "Mode: Walking (Eco)";
        stopCompassListener();
    }
}
function startCompassListener() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(r => {
            if (r === 'granted') window.addEventListener('deviceorientation', handleOrientation);
        });
    } else {
        window.addEventListener('deviceorientation', handleOrientation);
    }
}
function stopCompassListener() { window.removeEventListener('deviceorientation', handleOrientation); }
function handleOrientation(e) {
    if (e.webkitCompassHeading) currentHeading = e.webkitCompassHeading;
    else if (e.alpha) currentHeading = 360 - e.alpha;
}
function getHeadingNow() {
    return new Promise((resolve) => {
        if (COMPASS_MODE === "CONTINUOUS") { resolve(currentHeading || 0); return; }
        const handler = (e) => {
            let h = e.webkitCompassHeading || (360 - e.alpha) || 0;
            window.removeEventListener('deviceorientation', handler);
            resolve(h);
        };
        window.addEventListener('deviceorientation', handler);
        setTimeout(() => { window.removeEventListener('deviceorientation', handler); resolve(0); }, 500);
    });
}

function downloadRun(includePhotos) {
    const count = photoData.length;
    if (includePhotos && count === 0) alert("Notice: No photos in memory to save.");

    const dataObj = {
        version: "2.1",
        date: new Date().toISOString(),
        total_dist: totalDistance,
        duration: document.getElementById('time').innerText,
        track_points: trackData,
        photos: includePhotos ? photoData : [] 
    };

    const blob = new Blob([JSON.stringify(dataObj)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const timeString = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const type = includePhotos ? "FULL" : "TRACK";
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `Run_${timeString}_${type}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

function saveAndReset() {
    downloadRun(true); 
    setTimeout(() => {
        if(confirm("Run saved? Clear memory and start new?")) {
            resetRun(); // Clean up logic moved to function
            window.location.reload(); 
        }
    }, 1000); 
}

function resetRun() {
    startTime = Date.now();
    trackData = [];
    photoData = [];
    pathLayer.setLatLngs([]);
    totalDistance = 0;
    lastPos = null;
    clearMemory(); 
    clearPhotoDB(); // NEW: Wipe the Vault
    document.getElementById('dist').innerText = "0";
    document.getElementById('time').innerText = "00:00";
}

function updateUI(isRunning) {
    document.getElementById('btn-start').style.display = isRunning ? 'none' : 'block';
    document.getElementById('btn-stop').style.display = isRunning ? 'block' : 'none';
    document.getElementById('save-options').style.display = isRunning ? 'none' : 'grid';
    document.getElementById('btn-reset').style.display = isRunning ? 'none' : 'block';
    if(isRunning) document.getElementById('btn-start').innerText = "Resume Run";
}