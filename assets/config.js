// Public settings for the browser. The key below is Supabase's public "anon" key: it only lets a
// browser talk to the database, and row level security decides what each signed-in person can see.
// Never put the service_role key or any Stripe secret in this file.
window.CALACE_CONFIG = {
  supabaseUrl: "https://gtltpewsxxycrmnnhqum.supabase.co",
  supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0bHRwZXdzeHh5Y3Jtbm5ocXVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0NjEyNjMsImV4cCI6MjExMTAzNzI2M30.9csXnI0NaZwWm7_CYomFZWQqzhKKIHhS6E7jRXmw5ls",
  environment: "Staging",
  // Google Cloud project "CAL ACE Tracker": public identifiers only. The client secret lives in Supabase secrets.
  google: {
    clientId: "142989868176-tk7rdcg119am8k37vcc76qlvrta9i8sp.apps.googleusercontent.com",
    apiKey: "AIzaSyDtgDddG-075BlbCQlKU8lZbkvtoE1L4is",   // restricted to the Google Picker API and this site
    appId: "142989868176"                                 // project number
  }
};
