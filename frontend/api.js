const API = {
    async fetch(endpoint, options = {}) {
        const url = `${window.API_CONFIG.baseURL}${endpoint}`;

        const defaultHeaders = {
            'Content-Type': 'application/json'
        };

        options.headers = {
            ...defaultHeaders,
            ...(options.headers || {})
        };

        try {
            const response = await fetch(url, options);
            return response;
        } catch (error) {
            console.error(`Erro ao chamar ${endpoint}:`, error);
            throw error;
        }
    },

    async get(endpoint, token = null) {
        const options = {};
        if (token) {
            options.headers = { 'Authorization': `Bearer ${token}` };
        }
        return this.fetch(endpoint, options);
    },

    async post(endpoint, data, token = null) {
        const options = {
            method: 'POST',
            body: JSON.stringify(data)
        };
        if (token) {
            options.headers = { 'Authorization': `Bearer ${token}` };
        }
        return this.fetch(endpoint, options);
    },

    async delete(endpoint, token = null) {
        const options = {
            method: 'DELETE'
        };
        if (token) {
            options.headers = { 'Authorization': `Bearer ${token}` };
        }
        return this.fetch(endpoint, options);
    }
};

window.API = API;
