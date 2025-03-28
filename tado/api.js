const axiosLib = require('axios');
let axios = axiosLib.create();
const qs = require('qs')

const baseURL = 'https://my.tado.com/api/v2'
let log, storage, token, settings, homeId, deviceCode

const clientId = '1bb50063-6b0c-4d11-bd99-387f4a91cc46';
const deviceAuthURL = 'https://login.tado.com/oauth2/device_authorize';
const tokenURL = 'https://login.tado.com/oauth2/token';

module.exports = async function (platform) {
	log = platform.log
	storage = platform.storage
	deviceCode = platform.deviceCode

	const storageSettings = await storage.getItem('settings')
	if (storageSettings) {
		settings = storageSettings
		log.easyDebug(`Got settings from storage`)
	} else {
		settings = {}
	}

	axios.defaults.baseURL = baseURL
	
	if (platform.homeId)
		homeId = platform.homeId
	else {
		try {
			homeId = await get.HomeId()
		} catch(err) {
			log(`ERROR: Can't start the plugin without Home ID !!`)
			throw err
		}
	}
	
	return {
	
		getAllDevices: async () => {
			try {
				const temperatureUnit = await get.TemperatureUnit()
				const zones = await get.Zones()
				const installations = await get.Installations()

				const devices = zones.map(async zone => {
					let zoneState, capabilities
					try {
						zoneState = await get.State(zone.id)
						capabilities = await get.ZoneCapabilities(zone.id)
					} catch (err) {
						log(err)
						log(`COULD NOT get Zone ${zone.id} state and capabilities !! skipping device...`)
						return null
					}

					return {
						...zone,
						temperatureUnit: temperatureUnit,
						installation: installations[zone.id] || 'NON_THERMOSTATIC',
						capabilities: capabilities,
						state: zoneState,
						
					}
				})
				
				return await Promise.all(devices)
			} catch(err) {
				log(`Failed to get devices and states!!`)
				throw err
			}
		},
	
		setDeviceState: async (zoneId, overlay) => {
			const method = overlay ? 'put' : 'delete'
			const path = `/homes/${homeId}/zones/${zoneId}/overlay`
			return await setRequest(method, path, overlay)
		},

		getWeather: async () => {
			log.easyDebug(`Getting Weather Status from tado° API`)
			const path = `/homes/${homeId}/weather`
			try {
				const weather = await getRequest(path)
				weather.id = homeId
				settings.weather = weather
				storage.setItem('settings', settings)
				return weather
			} catch (err) {
				log.easyDebug(`The plugin was not able to retrieve Weather Status from tado° API !!`)
				if (settings.weather) {
					log.easyDebug(`Got Weather Status from storage  (NOT TO CRASH HOMEBRIDGE)  >>>`)
					log.easyDebug(JSON.stringify(settings.weather))
					return settings.weather
				}
				throw err
			}
		},

		getUsers: async () => {
			log.easyDebug(`Getting Users from tado° API`)
			const path = `/homes/${homeId}/users`
			try {
				const response = await getRequest(path)


				const users = response.filter(user => {
					user.trackedDevice = user.mobileDevices.find(device => device.settings.geoTrackingEnabled)
					return user.trackedDevice
				})

				settings.users = users
				log.easyDebug(`>>> Got Users from tado° API`)
				// log.easyDebug(JSON.stringify(users))
				storage.setItem('settings', settings)
				return users
			} catch (err) {
				log.easyDebug(`The plugin was not able to retrieve Users from tado° API !!`)
				if (settings.users) {
					log.easyDebug(`Got Users from storage  >>>`)
					log.easyDebug(JSON.stringify(settings.users))
					return settings.users
				}
				throw err
			}
		}
	}

}


function getDeviceCode() {
    return new Promise(async (resolve, reject) => {
        try {
            if (deviceCode) {
                resolve({
                    device_code: deviceCode
                });
		//log.easyDebug(`Device code: ${deviceCode}`)
            } else {
                reject(new Error("Device code not found in Homebridge config"));
            }
        } catch (err) {
            reject(err);
        }
    });
}

function readTokenFromStorage() {
    return new Promise((resolve, reject) => {
	tokenSettings = storage.getItem('tadoToken')
            .then(token => resolve(token))
            .catch(error => {
                log.easyDebug("Error reading token from storage:", error);
                reject(error);
            });
    });
}

function saveTokenToStorage(tokenData) {
    return new Promise((resolve, reject) => {
	tokenSettings = storage.setItem('tadoToken', tokenData)
            .then(() => {
                log.easyDebug("Token saved to storage.");
                resolve();
            })
            .catch(error => {
                log.easyDebug("Error saving token to storage:", error);
                reject(error);
            });
    });
}


function requestToken(deviceCode) {
    return new Promise((resolve, reject) => {
        // Read the token from storage
        readTokenFromStorage().then(storedToken => {
            // Check if a token exists and if it is still valid
            if (storedToken && storedToken.expirationDate > Date.now()) {
                log.easyDebug("Using existing valid token from storage.");
                resolve(storedToken.key);
                return;
            }

            // If token is expired or doesn't exist, try refreshing it
            if (storedToken && storedToken.expirationDate <= Date.now()) {
                log.easyDebug("Token expired, refreshing...");
                axios.post('https://login.tado.com/oauth2/token', qs.stringify({
                    client_id: clientId,
                    grant_type: 'refresh_token',
                    refresh_token: storedToken.refresh_token
                }))
                .then(refreshResponse => {
                    if (refreshResponse.data.access_token) {
                        // Update token with new access token and expiration date
                        const refreshedToken = {
                            key: refreshResponse.data.access_token,
                            expirationDate: Date.now() + refreshResponse.data.expires_in * 1000,
                            refresh_token: refreshResponse.data.refresh_token
                        };
                        saveTokenToStorage(refreshedToken).then(() => {
                            resolve(refreshedToken.key);
                        }).catch(err => {
                            reject(err);
                        });
                    } else {
                        reject("Failed to refresh token");
                    }
                })
                .catch(err => {
                    reject(err);
                });
                return;
            }

            // If no valid token, request a new token using device code
            log.easyDebug("No valid token, requesting a new one...");
            (function requestNewToken() {
                axios.post('https://login.tado.com/oauth2/token', qs.stringify({
                    client_id: clientId,
                    device_code: deviceCode,
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
                }))
                .then(response => {
                    if (response.data.access_token) {
                        // Save the new token and return it
                        const newToken = {
                            key: response.data.access_token,
                            expirationDate: Date.now() + response.data.expires_in * 1000,
                            refresh_token: response.data.refresh_token
                        };
                        saveTokenToStorage(newToken).then(() => {
                            resolve(newToken.key);
                        }).catch(err => {
                            reject(err);
                        });
                    }
                })
                .catch(err => {
                    if (err.response && err.response.status === 400 && err.response.data.error === 'authorization_pending') {
                        log.easyDebug(`Waiting for user authorization...`);
                        setTimeout(requestNewToken, 5000);
                    } else {
                        reject(err);
                    }
                });
            })();
        }).catch(err => {
            reject(err);
        });
    });
}

function getRequest(url) {
	return new Promise(async (resolve, reject) => {

		let headers
		try {
			const tokenResponse = await getToken()
			headers = {
				'Authorization': 'Bearer ' + tokenResponse
			}
		} catch (err) {
			log('[GET] The plugin was NOT able to find stored token or acquire one from tado° API')
			reject(err)
		}		
	
		log.easyDebug(`Creating GET request to tado° API --->`)
		log.easyDebug(baseURL + url)

		axios.get(url, { headers })
			.then(response => {
				const json = response.data
				log.easyDebug(`Successful GET response:`)
				log.easyDebug(JSON.stringify(json))
				resolve(json)
			})
			.catch(err => {
				log(`ERROR: ${err.message}`)
				if (err.response)
					log.easyDebug(err.response.data)
				reject(err)
			})
	})
}

function setRequest(method, url, data) {
	// eslint-disable-next-line no-async-promise-executor
	return new Promise(async (resolve, reject) => {
		
		let headers
		try {
			const tokenResponse = await getToken()
			headers = {
				'Authorization': 'Bearer ' + tokenResponse
			}
		} catch (err) {
			log('[SET] The plugin was NOT able to find stored token or acquire one from tado° API ---> it will not be able to set the state !!')
			reject(err)
		}
	
		log.easyDebug(`Creating ${method.toUpperCase()} request to tado° API --->`)
		log.easyDebug(baseURL + url)
		if (data)
			log.easyDebug('data: ' +JSON.stringify(data))

		axios({url, data, method, headers})
			.then(response => {
				const json = response.data
				log.easyDebug(`Successful ${method.toUpperCase()} response:`)
				log.easyDebug(JSON.stringify(json))
				resolve(json)
			})
			.catch(err => {
				log(`ERROR: ${err.message}`)
				if (err.response)
					log.easyDebug(err.response.data)
				reject(err)
			})
	})
}

function getToken() {
    return new Promise(async (resolve, reject) => {
        try {
            if (token && Date.now() < token.expirationDate) {
                return resolve(token.key);
            }

            const deviceCodeData = await getDeviceCode();
            const newToken = await requestToken(deviceCodeData.device_code)
            resolve(newToken);
        } catch (err) {
	    log.easyDebug(`Failed to get token`)
            reject(err);
        }
    });
}


const get = {
	HomeId: async () => {
		if (settings.homeId) {
			log.easyDebug(`Got Home ID from Storage  >>> ${settings.homeId} <<<`)
			return settings.homeId
		}

		log.easyDebug(`Getting Home ID from tado° API`)
		const path = '/me'
		try {
			const response = await getRequest(path)
			settings.homeId = response.homes[0].id
			log.easyDebug(`Got Home ID from tado° API  >>> ${settings.homeId} <<<`)
			storage.setItem('settings', settings)
			return settings.homeId
		} catch (err) {
			log.easyDebug(`The plugin was not able to retrieve Home ID from tado° API !!`)
			throw err
		}
	},


	TemperatureUnit: async () => {
		if (settings.temperatureUnit) {
			log.easyDebug(`Got Temperature Unit from Storage  >>> ${settings.temperatureUnit} <<<`)
			return settings.temperatureUnit
		}
			
		log.easyDebug(`Getting Temperature Unit from tado° API`)
		const path = `/homes/${homeId}`
		try {
			const response = await getRequest(path)
			settings.temperatureUnit = response.temperatureUnit
			log.easyDebug(`Got Temperature Unit from tado° API  >>> ${settings.temperatureUnit} <<<`)
			storage.setItem('settings', settings)
			return settings.temperatureUnit
		} catch (err) {
			log.easyDebug(`The plugin was not able to retrieve Temperature Unit from tado° API !! Using Celsius`)
			settings.temperatureUnit = 'CELSIUS'
			return settings.temperatureUnit
		}
	},

	Zones: async () => {
		log.easyDebug(`Getting Zones from tado° API`)
		const path = `/homes/${homeId}/zones`
		try {
			const response = await getRequest(path)
			const zones = response.filter(zone => zone.type === 'AIR_CONDITIONING')
			settings.zones = zones
			log.easyDebug(`>>> Got Zones from tado° API`)
			// log.easyDebug(JSON.stringify(zones))
			storage.setItem('settings', settings)
			return zones
		} catch (err) {
			log.easyDebug(`The plugin was not able to retrieve Zones from tado° API !!`)
			if (settings.zones) {
				log.easyDebug(`Got Zones from storage  >>>`)
				log.easyDebug(JSON.stringify(settings.zones))
				return settings.zones
			}
			throw err
		}
	},

	Installations: async () => {
		log.easyDebug(`Getting Installations from tado° API`)
		const path = `/homes/${homeId}/installations`
		try {
			const response = await getRequest(path)
			const installations = {}
			response.forEach(installation => {
				if (installation.acInstallationInformation) {
					const zoneId = installation.acInstallationInformation.createdZone.id
					installations[zoneId] = installation.acInstallationInformation.selectedSetupBranch
				}
			})

			settings.installations = installations
			log.easyDebug(`Got Installations from tado° API  >>>`)
			log.easyDebug(JSON.stringify(installations))
			storage.setItem('settings', settings)
			return installations
		} catch (err) {
			log(err)
			log.easyDebug(`The plugin was not able to retrieve Installations from tado° API !!`)
			if (settings.installations) {
				log.easyDebug(`Got Installations from storage  >>>`)
				log.easyDebug(JSON.stringify(settings.installations))
				return settings.installations
			}
			return false
		}
	},


	ZoneCapabilities: async (zoneId) => {
		log.easyDebug(`Getting Zone Capabilities from tado° API`)
		const path = `/homes/${homeId}/zones/${zoneId}/capabilities`
		try {
			const capabilities = await getRequest(path)
			log.easyDebug(`>>> Got Zone ${zoneId} Capabilities from tado° API`)
			// log.easyDebug(JSON.stringify(capabilities))

			if (!settings.capabilities)
				settings.capabilities = {}

			settings.capabilities[zoneId] = capabilities
			storage.setItem('settings', settings)
			return capabilities
		} catch (err) {
			log.easyDebug(`The plugin was not able to retrieve Zone ${zoneId} Capabilities from tado° API !!`)
			if (settings.capabilities && settings.capabilities[zoneId]) {
				log.easyDebug(`Got Zone ${zoneId} Capabilities from storage  >>>`)
				log.easyDebug(JSON.stringify(settings.capabilities[zoneId]))
				return settings.capabilities[zoneId]
			}
			throw err
		}
	},

	State: async (zoneId) => {
		log.easyDebug(`Getting Zone state from tado° API`)
		const path = `/homes/${homeId}/zones/${zoneId}/state`
		try {
			const state = await getRequest(path)
			log.easyDebug(`>>> Got Zone ${zoneId} state from tado° API  >>>`)
			// log.easyDebug(JSON.stringify(state))

			if (!settings.states)
				settings.states = {}

			settings.states[zoneId] = state
			storage.setItem('settings', settings)
			return state
		} catch (err) {
			log.easyDebug(`The plugin was not able to retrieve Zone ${zoneId} state from tado° API !!`)
			if (settings.states && settings.states[zoneId]) {
				log.easyDebug(`Got Zone ${zoneId} state from storage  (NOT TO CRASH HOMEBRIDGE) >>>`)
				log.easyDebug(JSON.stringify(settings.states[zoneId]))
				return settings.states[zoneId]
			}
			throw err
		}
	}
}
