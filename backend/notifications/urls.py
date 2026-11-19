from django.urls import path
from . import views

urlpatterns = [
    path("notifications/", views.NotificationListView.as_view()),
    path("notifications/unread/", views.UnreadListView.as_view()),
    path("notifications/mark-all-read/", views.MarkAllReadView.as_view()),
    path("notifications/preferences/", views.NotificationPreferencesView.as_view()),
    path("notifications/<int:pk>/", views.NotificationDetailView.as_view()),
    path("notifications/<int:pk>/read/", views.MarkReadView.as_view()),
]