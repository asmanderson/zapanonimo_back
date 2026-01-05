
const API_CONFIG = {
    production: 'https://zapanonimo.fly.dev',
    development: 'http://localhost:3000',
    get baseURL() {
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            return this.development;
        }

        return this.production;
    }
};

window.API_CONFIG = API_CONFIG;
